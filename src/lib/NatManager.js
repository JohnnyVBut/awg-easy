'use strict';

const fs = require('fs').promises;
const path = require('path');
const { createError } = require('h3');
const Util = require('./Util');
const debug = require('debug')('awg:NatManager');

const DATA_FILE = '/etc/wireguard/data/nat-rules.json';

/**
 * NatManager — управление правилами Source NAT (iptables-nft POSTROUTING).
 *
 * Хранит правила в /etc/wireguard/data/nat-rules.json.
 * При старте восстанавливает все enabled правила в ядро.
 *
 * Модель правила:
 *   {
 *     id:           string   — UUID
 *     name:         string   — Отображаемое имя
 *     enabled:      boolean  — Активно ли правило
 *     source:       string   — '' (any), 'x.x.x.x/yy' (subnet), 'x.x.x.x' (IP)
 *     outInterface: string   — Выходной сетевой интерфейс (eth0, wg10, ...)
 *     type:         string   — 'MASQUERADE' | 'SNAT'
 *     toSource:     string|null — Целевой IP для SNAT (null при MASQUERADE)
 *     comment:      string   — Комментарий (необязательно)
 *     createdAt:    string   — ISO timestamp
 *   }
 *
 * Генерируемые команды:
 *   # MASQUERADE (any source):
 *   iptables-nft -t nat -A POSTROUTING -o eth0 -j MASQUERADE
 *
 *   # MASQUERADE (конкретная подсеть):
 *   iptables-nft -t nat -A POSTROUTING -s 10.8.0.0/24 -o eth0 -j MASQUERADE
 *
 *   # SNAT:
 *   iptables-nft -t nat -A POSTROUTING -s 10.8.0.0/24 -o eth0 -j SNAT --to-source 1.2.3.4
 *
 *   Удаление — те же аргументы, -A → -D. Детерминированно реконструируется из JSON.
 *
 * Связь с TunnelInterface.js PostUp/PostDown:
 *   Правила из PostUp/PostDown управляются wg-quick и работают независимо.
 *   NatManager не конфликтует с ними — управляет только своими правилами.
 */
class NatManager {

  constructor() {
    /** @type {Array<object>} список NAT правил */
    this.rules = [];
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Инициализация: загрузить JSON, применить все enabled правила в ядро.
   * Вызывается единожды (singleton), eagerly при старте сервера.
   */
  async init() {
    debug('Initializing NatManager...');
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });

    try {
      const json = await fs.readFile(DATA_FILE, 'utf8');
      this.rules = JSON.parse(json);
      debug(`Loaded ${this.rules.length} NAT rules`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.rules = [];
      debug('No nat-rules.json found, starting fresh');
    }

    // Восстановить enabled правила в ядро после перезапуска контейнера.
    // _applyRule использует -C (check) перед -A: если правило уже есть в ядре
    // (выжило после docker restart) — не добавляет дубликат и сохраняет счётчики
    // pkts/bytes. Без -C каждый restart создавал бы новую копию с нулевыми счётчиками.
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      try {
        await this._applyRule(rule);
        debug(`Restored NAT rule "${rule.name}"`);
      } catch (err) {
        debug(`Failed to restore NAT rule "${rule.name}": ${err.message}`);
      }
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Получить список сетевых интерфейсов хоста для выбора outbound-интерфейса.
   *
   * Использует `ip -o link show` (текстовый вывод, без -j — см. FIX-11).
   * Формат строки: "2: eth0: <flags> mtu ..."
   *
   * @returns {Promise<Array<{name: string}>>}
   */
  async getNetworkInterfaces() {
    try {
      const out = await Util.exec('ip -o link show', { log: false, timeout: 5000 });
      const ifaces = [];
      for (const line of (out || '').split('\n')) {
        if (!line.trim()) continue;
        // Захватываем имя интерфейса (до ':' или '@', без пробелов)
        const m = line.match(/^\d+:\s+([^:@\s]+)/);
        if (!m) continue;
        const name = m[1].trim();
        if (name === 'lo') continue; // loopback не нужен для NAT
        ifaces.push({ name });
      }
      return ifaces;
    } catch (err) {
      debug(`getNetworkInterfaces failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Получить список NAT правил.
   * @returns {Array<object>}
   */
  getRules() {
    return this.rules;
  }

  /**
   * Создать новое NAT правило.
   *
   * @param {object} data
   * @param {string}      data.name         - Название (обязательно)
   * @param {string}      [data.source]     - '' | 'x.x.x.x/yy' | 'x.x.x.x'
   * @param {string}      data.outInterface - Выходной интерфейс (обязательно)
   * @param {string}      data.type         - 'MASQUERADE' | 'SNAT'
   * @param {string|null} [data.toSource]   - IP для SNAT (обязательно при type=SNAT)
   * @param {string}      [data.comment]    - Комментарий
   * @returns {Promise<object>} созданное правило
   */
  async addRule(data) {
    this._validate(data);

    const rule = {
      id:            this._uuid(),
      name:          data.name.trim(),
      enabled:       true,
      source:        data.sourceAliasId ? '' : (data.source || '').trim(),
      sourceAliasId: data.sourceAliasId || null,
      outInterface:  data.outInterface.trim(),
      type:          data.type,
      toSource:      data.type === 'SNAT' ? (data.toSource || '').trim() : null,
      comment:       (data.comment || '').trim(),
      createdAt:     new Date().toISOString(),
    };

    await this._applyRule(rule);
    this.rules.push(rule);
    await this._save();

    debug(`NAT rule added: "${rule.name}" (${rule.type} via ${rule.outInterface})`);
    return rule;
  }

  /**
   * Обновить существующее NAT правило.
   * Удаляет старое правило из ядра (если было enabled), применяет новое.
   *
   * @param {string} id     - UUID правила
   * @param {object} data   - Те же поля, что и в addRule()
   * @returns {Promise<object>} обновлённое правило
   */
  async updateRule(id, data) {
    const idx = this.rules.findIndex(r => r.id === id);
    if (idx === -1) throw createError({ status: 404, message: 'NAT rule not found' });

    const old = this.rules[idx];
    this._validate(data);

    const updated = {
      ...old,
      name:          data.name.trim(),
      source:        data.sourceAliasId ? '' : (data.source || '').trim(),
      sourceAliasId: data.sourceAliasId || null,
      outInterface:  data.outInterface.trim(),
      type:          data.type,
      toSource:      data.type === 'SNAT' ? (data.toSource || '').trim() : null,
      comment:       (data.comment || '').trim(),
    };

    // Удалить старое правило из ядра (если было активно)
    if (old.enabled) {
      try {
        await this._removeRule(old);
      } catch (err) {
        debug(`Remove old rule failed (may already be gone): ${err.message}`);
      }
    }

    // Применить новое правило (если enabled)
    if (updated.enabled) {
      await this._applyRule(updated);
    }

    this.rules.splice(idx, 1, updated);
    await this._save();

    debug(`NAT rule updated: "${updated.name}"`);
    return updated;
  }

  /**
   * Удалить NAT правило.
   *
   * @param {string} id - UUID правила
   */
  async deleteRule(id) {
    const idx = this.rules.findIndex(r => r.id === id);
    if (idx === -1) throw createError({ status: 404, message: 'NAT rule not found' });

    const rule = this.rules[idx];

    // Удалить из ядра (если было активно)
    if (rule.enabled) {
      try {
        await this._removeRule(rule);
      } catch (err) {
        debug(`Remove rule from kernel failed (may already be gone): ${err.message}`);
      }
    }

    this.rules.splice(idx, 1);
    await this._save();
    debug(`NAT rule deleted: "${rule.name}"`);
  }

  /**
   * Включить / выключить NAT правило.
   *
   * @param {string}  id      - UUID правила
   * @param {boolean} enabled - true = включить, false = выключить
   * @returns {Promise<object>} обновлённое правило
   */
  async toggleRule(id, enabled) {
    const rule = this.rules.find(r => r.id === id);
    if (!rule) throw createError({ status: 404, message: 'NAT rule not found' });

    if (enabled && !rule.enabled) {
      await this._applyRule(rule);
    } else if (!enabled && rule.enabled) {
      await this._removeRule(rule);
    }

    rule.enabled = enabled;
    await this._save();
    return rule;
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  /**
   * Валидация полей нового/обновлённого правила.
   * @throws {H3Error} при невалидных данных
   */
  _validate(data) {
    if (!data.name || !data.name.trim()) {
      throw createError({ status: 400, message: 'Rule name is required' });
    }
    if (!data.outInterface || !data.outInterface.trim()) {
      throw createError({ status: 400, message: 'Outbound interface is required' });
    }
    // Имя интерфейса: только буквы, цифры, точки, дефисы (безопасность от shell injection)
    if (/[^a-zA-Z0-9._-]/.test(data.outInterface.trim())) {
      throw createError({ status: 400, message: 'Invalid interface name' });
    }
    if (!['MASQUERADE', 'SNAT'].includes(data.type)) {
      throw createError({ status: 400, message: 'Type must be MASQUERADE or SNAT' });
    }
    if (data.type === 'SNAT' && (!data.toSource || !data.toSource.trim())) {
      throw createError({ status: 400, message: 'SNAT requires a target IP (toSource)' });
    }
    // Валидация source (если указан и не alias): должен быть IP или CIDR
    if (!data.sourceAliasId) {
      const src = (data.source || '').trim();
      if (src && !/^[\d.]+(?:\/\d{1,2})?$/.test(src)) {
        throw createError({ status: 400, message: 'Invalid source address or CIDR' });
      }
    }
    // Валидация toSource IP
    if (data.type === 'SNAT') {
      const ip = (data.toSource || '').trim();
      if (!/^[\d.]+$/.test(ip)) {
        throw createError({ status: 400, message: 'Invalid SNAT target IP' });
      }
    }
  }

  /**
   * Построить список команд iptables-nft для правила.
   * Один rule → N команд (по одной на каждый entry алиаса, или одна для plain source).
   *
   * @param {object}       rule   - NAT правило
   * @param {'A'|'D'|'C'}  action - 'A' = append, 'D' = delete, 'C' = check
   * @returns {Promise<string[]>} список команд
   */
  async _buildCmds(rule, action) {
    const srcParts = await this._resolveSrcParts(rule);
    return srcParts.map(srcPart => {
      let cmd = `iptables-nft -t nat -${action} POSTROUTING`;
      if (srcPart) cmd += ` ${srcPart}`;
      cmd += ` -o ${rule.outInterface}`;
      if (rule.type === 'MASQUERADE') cmd += ' -j MASQUERADE';
      else cmd += ` -j SNAT --to-source ${rule.toSource}`;
      return cmd;
    });
  }

  /**
   * Вернуть массив source-частей команды iptables-nft для правила.
   * null/'' = без ограничения по source (any).
   * @returns {Promise<Array<string|null>>}
   */
  async _resolveSrcParts(rule) {
    if (rule.sourceAliasId) {
      return this._resolveAliasSrcParts(rule.sourceAliasId);
    }
    if (rule.source) return [`-s ${rule.source}`];
    return [null]; // any
  }

  /**
   * Разложить алиас на массив iptables source-частей.
   * host/network → ['-s 10.0.0.1', '-s 10.0.0.2', ...]
   * ipset        → ['-m set --match-set <name> src']
   * group        → рекурсивный обход участников
   */
  async _resolveAliasSrcParts(aliasId) {
    const { getInstance } = require('./AliasManager');
    const am = await getInstance();
    const alias = am.getAlias(aliasId);
    if (!alias) {
      debug(`Alias ${aliasId} not found, applying no source restriction`);
      return [null];
    }
    if (alias.type === 'ipset') {
      return [`-m set --match-set ${alias.name} src`];
    }
    if (alias.type === 'host' || alias.type === 'network') {
      const entries = alias.entries || [];
      if (entries.length === 0) return [null];
      return entries.map(e => `-s ${e}`);
    }
    if (alias.type === 'group') {
      const parts = [];
      for (const memberId of (alias.memberIds || [])) {
        const sub = await this._resolveAliasSrcParts(memberId);
        parts.push(...sub.filter(p => p !== null));
      }
      return parts.length > 0 ? parts : [null];
    }
    // port/port-group — не применимо для L3 NAT
    debug(`Alias ${aliasId} type "${alias.type}" not applicable for NAT source, ignoring`);
    return [null];
  }

  /**
   * Добавить правило в ядро через iptables-nft (идемпотентно: -C перед -A).
   */
  async _applyRule(rule) {
    const cmds = await this._buildCmds(rule, 'A');
    const checkCmds = await this._buildCmds(rule, 'C');
    for (let i = 0; i < cmds.length; i++) {
      try {
        await Util.exec(checkCmds[i], { log: false, timeout: 5000 });
        debug(`Apply (already in kernel): ${cmds[i]}`);
      } catch {
        debug(`Apply:  ${cmds[i]}`);
        await Util.exec(cmds[i]);
      }
    }
  }

  /** Удалить правило из ядра через iptables-nft. */
  async _removeRule(rule) {
    const cmds = await this._buildCmds(rule, 'D');
    for (const cmd of cmds) {
      debug(`Remove: ${cmd}`);
      await Util.exec(cmd);
    }
  }

  /**
   * Удалить ВСЕ копии правила из ядра (loop -D до ошибки).
   * Используется в init() для очистки дубликатов накопленных при предыдущих запусках.
   */
  async _flushRule(rule) {
    const cmds = await this._buildCmds(rule, 'D');
    for (const delCmd of cmds) {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          await Util.exec(delCmd, { log: false, timeout: 5000 });
        } catch {
          break; // Копий больше нет
        }
      }
    }
  }

  /** Сохранить правила в JSON-файл. */
  async _save() {
    await fs.writeFile(DATA_FILE, JSON.stringify(this.rules, null, 2));
  }

  /** Генератор UUID v4. */
  _uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let instance = null;
let instanceReady = null;

module.exports = {
  /**
   * Получить singleton экземпляр NatManager (инициализируется при первом вызове).
   * @returns {Promise<NatManager>}
   */
  getInstance: async () => {
    if (!instance) {
      instance = new NatManager();
      instanceReady = instance.init();
    }
    await instanceReady;
    return instance;
  },
};
