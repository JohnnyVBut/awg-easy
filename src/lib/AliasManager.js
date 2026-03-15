'use strict';

const fs      = require('fs').promises;
const path    = require('path');
const { v4: uuidv4 } = require('uuid');
const { createError } = require('h3');
const IpsetManager = require('./IpsetManager');
const debug   = require('debug')('awg:AliasManager');

const ALIASES_DIR = '/etc/wireguard/data/aliases';

/**
 * AliasManager — именованные наборы адресов (Firewall Aliases).
 *
 * Четыре типа алиасов:
 *
 *   host     — один или несколько IP-адресов (напр. "1.2.3.4", "5.6.7.8")
 *              Хранятся в entries[]. Применяются как -s/-d в iptables напрямую.
 *
 *   network  — один или несколько CIDR-префиксов (напр. "192.168.0.0/16")
 *              Аналогично host, но для подсетей.
 *
 *   ipset    — kernel ipset (hash:net, обычно большой: 1K-100K записей).
 *              ipsetName указывает имя kernel-объекта.
 *              Данные хранятся в /etc/wireguard/data/ipsets/<ipsetName>.save
 *              и восстанавливаются через IpsetManager.restoreAll().
 *
 *   group    — объединяет несколько host/network алиасов в один.
 *              Хранит ссылки: memberIds: [uuid, uuid, ...].
 *              getMatchSpec() возвращает merged deduplicated список entries.
 *              Ограничение: members должны быть type=host или type=network
 *              (не ipset, не group — вложенные группы не поддерживаются).
 *
 * Алиасы переиспользуются в:
 *   - FirewallManager (source / destination в iptables-правилах)
 *
 * Персистентность: /etc/wireguard/data/aliases/<id>.json
 *
 * Модель алиаса:
 * {
 *   id:            string   — UUID
 *   name:          string   — уникальное имя (используется в UI и в логах)
 *   description:   string   — произвольный комментарий
 *   type:          string   — 'host' | 'network' | 'ipset' | 'group'
 *   entries:       string[] — для host/network: список IP/CIDR; для group/ipset: []
 *   memberIds:     string[] — для type=group: UUID-ы members; иначе []
 *   ipsetName:     string|null — для type=ipset: имя kernel ipset
 *   entryCount:    number   — кол-во записей (для group: сумма member.entryCount)
 *   generatorOpts: object|null — параметры последней генерации через prefixes.py
 *                               { country? | asn? | asnList? }
 *   lastUpdated:   string|null — ISO timestamp последнего обновления данных
 *   createdAt:     string   — ISO timestamp создания
 * }
 */
class AliasManager {

  constructor() {
    /** @type {Map<string, object>} id → alias data */
    this.aliases = new Map();
    this._ipsetMgr = null; // инициализируется в init()
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async init() {
    debug('Initializing AliasManager...');
    await fs.mkdir(ALIASES_DIR, { recursive: true });

    // Получить IpsetManager (уже инициализирован к этому моменту)
    this._ipsetMgr = await IpsetManager.getInstance();

    // Загрузить алиасы с диска
    const files = await fs.readdir(ALIASES_DIR).catch(() => []);
    for (const f of files.filter(f => f.endsWith('.json'))) {
      try {
        const raw = await fs.readFile(path.join(ALIASES_DIR, f), 'utf8');
        const alias = JSON.parse(raw);
        // Миграция: старые алиасы не имеют поля memberIds
        if (!alias.memberIds) alias.memberIds = [];
        this.aliases.set(alias.id, alias);
        debug(`Loaded alias: ${alias.id} (${alias.name}, ${alias.type})`);
      } catch (err) {
        debug(`Failed to load alias ${f}: ${err.message}`);
      }
    }

    debug(`AliasManager ready: ${this.aliases.size} aliases`);
  }

  // ─── Public CRUD ───────────────────────────────────────────────────────────

  /**
   * Создать новый алиас.
   *
   * @param {object} data
   * @param {string}   data.name         - Уникальное имя (обязательно)
   * @param {string}   data.type         - 'host' | 'network' | 'ipset' | 'group'
   * @param {string[]} [data.entries]    - Для host/network
   * @param {string[]} [data.memberIds]  - Для group: UUID-ы алиасов-участников
   * @param {string}   [data.description]
   * @returns {Promise<object>} созданный алиас
   */
  async createAlias(data) {
    this._validate(data);
    this._checkNameUnique(data.name);

    // Для group: валидировать members
    if (data.type === 'group') {
      this._validateMembers(data.memberIds);
    }

    const isGroup  = data.type === 'group';
    const isIpset  = data.type === 'ipset';
    const isPlain  = !isGroup && !isIpset; // host или network

    const memberIds = isGroup ? [...new Set(data.memberIds)] : [];
    const entries   = isPlain ? this._normalizeEntries(data.entries || []) : [];

    const alias = {
      id:            uuidv4(),
      name:          data.name.trim(),
      description:   (data.description || '').trim(),
      type:          data.type,
      entries,
      memberIds,
      ipsetName:     isIpset ? this._ipsetNameFromAlias(data.name.trim()) : null,
      entryCount:    isPlain  ? entries.length
                   : isGroup  ? this._groupEntryCount(memberIds)
                   : 0,
      generatorOpts: null,
      lastUpdated:   isPlain && entries.length ? new Date().toISOString() : null,
      createdAt:     new Date().toISOString(),
    };

    // Для ipset: создать kernel set
    if (isIpset) {
      await this._ipsetMgr.createSet(alias.ipsetName);
    }

    await this._saveAlias(alias);
    this.aliases.set(alias.id, alias);

    debug(`Alias created: ${alias.id} (${alias.name}, ${alias.type})`);
    return alias;
  }

  /**
   * Обновить алиас (name, description, entries для host/network, memberIds для group).
   * Нельзя изменить type.
   *
   * @param {string} id
   * @param {object} data - { name?, description?, entries?, memberIds? }
   * @returns {Promise<object>}
   */
  async updateAlias(id, data) {
    const alias = this._getOrThrow(id);

    if (data.name && data.name.trim() !== alias.name) {
      this._checkNameUnique(data.name.trim(), id);
      alias.name = data.name.trim();
    }
    if (data.description !== undefined) {
      alias.description = (data.description || '').trim();
    }

    if (alias.type === 'group' && data.memberIds !== undefined) {
      this._validateMembers(data.memberIds);
      alias.memberIds  = [...new Set(data.memberIds)];
      alias.entryCount = this._groupEntryCount(alias.memberIds);
      alias.lastUpdated = new Date().toISOString();
    }

    if (data.entries !== undefined && (alias.type === 'host' || alias.type === 'network')) {
      alias.entries    = this._normalizeEntries(data.entries);
      alias.entryCount = alias.entries.length;
      alias.lastUpdated = new Date().toISOString();
    }

    await this._saveAlias(alias);
    debug(`Alias updated: ${id}`);
    return alias;
  }

  /**
   * Удалить алиас.
   * Для ipset: уничтожает kernel set и .save файл.
   * Для host/network: проверяет что алиас не используется в группах.
   *
   * @param {string} id
   */
  async deleteAlias(id) {
    const alias = this._getOrThrow(id);

    // Не разрешаем удалять если используется в группе
    for (const a of this.aliases.values()) {
      if (a.type === 'group' && (a.memberIds || []).includes(id)) {
        throw createError({ status: 409, message: `Alias "${alias.name}" is used in group "${a.name}"` });
      }
    }

    if (alias.type === 'ipset' && alias.ipsetName) {
      await this._ipsetMgr.destroySet(alias.ipsetName).catch(err =>
        debug(`destroySet ${alias.ipsetName} on delete: ${err.message}`)
      );
    }

    await fs.unlink(path.join(ALIASES_DIR, `${id}.json`)).catch(() => {});
    this.aliases.delete(id);

    debug(`Alias deleted: ${id} (${alias.name})`);
  }

  /**
   * Получить алиас по id.
   */
  getAlias(id) {
    return this.aliases.get(id) || null;
  }

  /**
   * Получить алиас по имени.
   */
  getAliasByName(name) {
    for (const a of this.aliases.values()) {
      if (a.name === name) return a;
    }
    return null;
  }

  /**
   * Получить список всех алиасов.
   */
  getAllAliases() {
    return Array.from(this.aliases.values());
  }

  // ─── Ipset: Upload & Generate ──────────────────────────────────────────────

  /**
   * Загрузить содержимое ipset из txt-файла.
   * Только для алиасов type=ipset.
   *
   * @param {string} id       - UUID алиаса
   * @param {string} filePath - Временный путь к загруженному файлу
   * @returns {Promise<object>} обновлённый алиас
   */
  async uploadFromFile(id, filePath) {
    const alias = this._getOrThrow(id);
    if (alias.type !== 'ipset') {
      throw createError({ status: 400, message: 'Upload only supported for ipset-type aliases' });
    }

    const count = await this._ipsetMgr.loadFromFile(alias.ipsetName, filePath);
    await this._ipsetMgr.saveSet(alias.ipsetName);

    alias.entryCount  = count;
    alias.lastUpdated = new Date().toISOString();
    alias.generatorOpts = null; // сбросить — это ручная загрузка
    await this._saveAlias(alias);

    debug(`Alias ${id}: uploaded ${count} entries from file`);
    return alias;
  }

  /**
   * Запустить генерацию ipset через prefixes.py (асинхронно, возвращает jobId).
   * Только для алиасов type=ipset.
   *
   * @param {string} id   - UUID алиаса
   * @param {object} opts - { country?, asn?, asnList? }
   * @returns {string} jobId для polling через getGenerateJobStatus()
   */
  startGenerate(id, opts) {
    const alias = this._getOrThrow(id);
    if (alias.type !== 'ipset') {
      throw createError({ status: 400, message: 'Generate only supported for ipset-type aliases' });
    }

    // Сохранить opts для будущих обновлений
    alias.generatorOpts = opts;
    this._saveAlias(alias).catch(err => debug(`Save alias during generate: ${err.message}`));

    // Запустить генерацию
    const jobId = this._ipsetMgr.runGenerator(alias.ipsetName, opts);

    // Когда job завершится — обновить alias.entryCount (polling в фоне)
    this._watchJob(jobId, alias);

    return jobId;
  }

  /**
   * Получить статус generation job.
   *
   * @param {string} jobId
   * @returns {{ status, entryCount?, error? }|null}
   */
  getGenerateJobStatus(jobId) {
    return this._ipsetMgr.getJobStatus(jobId);
  }

  // ─── Match spec (для FirewallManager) ─────────────────────────────────────

  /**
   * Получить "match specification" алиаса для использования в iptables.
   *
   * Возвращает:
   *   { type: 'ipset', name: 'ru_nets' }
   *   { type: 'cidr',  entries: ['192.168.0.0/16', '10.0.0.0/8'] }
   *
   * Для group: рекурсивно объединяет entries всех members, дедуплицирует.
   *
   * @param {string} id
   * @returns {{ type: 'ipset'|'cidr', name?: string, entries?: string[] }}
   */
  getMatchSpec(id) {
    const alias = this._getOrThrow(id);

    if (alias.type === 'ipset') {
      return { type: 'ipset', name: alias.ipsetName };
    }

    if (alias.type === 'group') {
      const merged = [];
      for (const memberId of (alias.memberIds || [])) {
        const member = this.aliases.get(memberId);
        if (!member) continue;
        merged.push(...(member.entries || []));
      }
      // Дедупликация
      return { type: 'cidr', entries: [...new Set(merged)] };
    }

    // host / network
    return { type: 'cidr', entries: alias.entries };
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  _getOrThrow(id) {
    const alias = this.aliases.get(id);
    if (!alias) throw createError({ status: 404, message: `Alias ${id} not found` });
    return alias;
  }

  _validate(data) {
    if (!data.name || !data.name.trim()) {
      throw createError({ status: 400, message: 'Alias name is required' });
    }
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/.test(data.name.trim())) {
      throw createError({ status: 400, message: 'Alias name must start with a letter and contain only letters, digits, _ or -' });
    }
    if (!['host', 'network', 'ipset', 'group'].includes(data.type)) {
      throw createError({ status: 400, message: 'Alias type must be host, network, ipset, or group' });
    }
  }

  /**
   * Валидировать список memberIds для group.
   * @param {string[]} memberIds
   */
  _validateMembers(memberIds) {
    if (!Array.isArray(memberIds) || memberIds.length === 0) {
      throw createError({ status: 400, message: 'Group alias must have at least one member' });
    }
    for (const memberId of memberIds) {
      const member = this.aliases.get(memberId);
      if (!member) {
        throw createError({ status: 400, message: `Member alias ${memberId} not found` });
      }
      if (member.type !== 'host' && member.type !== 'network') {
        throw createError({ status: 400, message: `Member alias "${member.name}" must be type host or network (got ${member.type})` });
      }
    }
  }

  /**
   * Вычислить суммарное количество записей для group (сумма member.entryCount).
   * @param {string[]} memberIds
   * @returns {number}
   */
  _groupEntryCount(memberIds) {
    let total = 0;
    for (const memberId of memberIds) {
      const member = this.aliases.get(memberId);
      if (member) total += member.entryCount || 0;
    }
    return total;
  }

  _checkNameUnique(name, excludeId = null) {
    for (const a of this.aliases.values()) {
      if (a.name === name && a.id !== excludeId) {
        throw createError({ status: 409, message: `Alias name "${name}" already exists` });
      }
    }
  }

  _normalizeEntries(entries) {
    return entries
      .map(e => e.trim())
      .filter(Boolean);
  }

  /**
   * Derive ipset name from alias name:
   * - lowercase, replace '-' with '_', truncate to 31 chars (ipset limit)
   */
  _ipsetNameFromAlias(name) {
    return name.toLowerCase().replace(/-/g, '_').slice(0, 31);
  }

  async _saveAlias(alias) {
    await fs.writeFile(
      path.join(ALIASES_DIR, `${alias.id}.json`),
      JSON.stringify(alias, null, 2)
    );
  }

  /**
   * Фоновый watch: когда job завершится → обновить entryCount алиаса.
   */
  _watchJob(jobId, alias) {
    const interval = setInterval(async () => {
      const status = this._ipsetMgr.getJobStatus(jobId);
      if (!status || status.status === 'running') return;

      clearInterval(interval);

      if (status.status === 'done') {
        alias.entryCount  = status.entryCount || 0;
        alias.lastUpdated = new Date().toISOString();
        await this._saveAlias(alias).catch(err =>
          debug(`Save alias after job ${jobId}: ${err.message}`)
        );
        debug(`Alias ${alias.id} updated: ${alias.entryCount} entries after generate`);
      } else {
        debug(`Generate job ${jobId} failed for alias ${alias.id}: ${status.error}`);
      }
    }, 2000);
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let instance = null;
let instanceReady = null;

module.exports = {
  getInstance: async () => {
    if (!instance) {
      instance      = new AliasManager();
      instanceReady = instance.init();
    }
    await instanceReady;
    return instance;
  },
};
