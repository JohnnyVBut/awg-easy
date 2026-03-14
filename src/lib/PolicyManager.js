'use strict';

const fs      = require('fs').promises;
const path    = require('path');
const { v4: uuidv4 } = require('uuid');
const { createError } = require('h3');
const Util          = require('./Util');
const GatewayManager = require('./GatewayManager');
const AliasManager  = require('./AliasManager');
const debug         = require('debug')('awg:PolicyManager');

const DATA_FILE = '/etc/wireguard/data/policy-rules.json';

/**
 * PolicyManager — управление Policy-Based Routing (PBR).
 *
 * Каждое правило создаёт полный PBR-пайплайн в ядре Linux:
 *
 *   1. iptables-nft mangle PREROUTING — пометить пакеты fwmark
 *      Условия: source (alias/CIDR/any) + destination (alias/CIDR/any, опционально инвертировать)
 *      Действие: -j MARK --set-mark <fwmark>
 *
 *   2. ip route add default via <gw.gatewayIP> dev <gw.interface> table <fwmark>
 *      Выделенная таблица маршрутизации N = fwmark.
 *
 *   3. ip rule add fwmark <fwmark> lookup <fwmark> priority <priority>
 *      Политика: трафик с нужным mark → lookup таблица N.
 *
 * Модель правила:
 * {
 *   id:             string     — UUID
 *   name:           string
 *   enabled:        boolean
 *   priority:       number     — приоритет ip rule (меньше = выше; диапазон 100-32000)
 *   fwmark:         number     — метка пакетов (1000-32000, автоназначается)
 *   source: {
 *     type:         'alias'|'cidr'|'any'
 *     aliasId?:     string     — UUID алиаса (type=alias)
 *     value?:       string     — CIDR или IP (type=cidr)
 *   }
 *   destination: {
 *     type:         'alias'|'cidr'|'any'
 *     aliasId?:     string
 *     value?:       string
 *     invert:       boolean    — true = NOT match (трафик НЕ в этот набор)
 *   }
 *   gatewayId:      string|null  — UUID Gateway
 *   gatewayGroupId: string|null  — UUID GatewayGroup (используется вместо gatewayId)
 *   createdAt:      string
 * }
 *
 * fwmark = routing table number (таблица N = fwmark N) — упрощает диагностику.
 * Диапазон: 1000-32000 (избегаем 0-999: зарезервированы системой).
 *
 * Идемпотентность:
 *   - mangle:   -C check перед -A
 *   - ip route: проверяем `ip route show table N` перед add
 *   - ip rule:  проверяем `ip rule show` перед add
 */
class PolicyManager {

  constructor() {
    /** @type {object[]} */
    this.rules = [];
    this._aliasMgr   = null;
    this._gatewayMgr = null;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async init() {
    debug('Initializing PolicyManager...');
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });

    this._aliasMgr   = await AliasManager.getInstance();
    this._gatewayMgr = await GatewayManager.getInstance();

    // Загрузить правила с диска
    try {
      const json = await fs.readFile(DATA_FILE, 'utf8');
      this.rules = JSON.parse(json);
      debug(`Loaded ${this.rules.length} policy rules`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.rules = [];
      debug('No policy-rules.json, starting fresh');
    }

    // Восстановить enabled правила в ядро
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      try {
        await this._applyRule(rule);
        debug(`Restored policy rule: "${rule.name}"`);
      } catch (err) {
        debug(`Failed to restore policy rule "${rule.name}": ${err.message}`);
      }
    }

    debug('PolicyManager ready');
  }

  // ─── Public CRUD ───────────────────────────────────────────────────────────

  /**
   * Создать новое PBR-правило.
   *
   * @param {object} data
   * @returns {Promise<object>}
   */
  async addRule(data) {
    this._validateRule(data);

    const rule = {
      id:             uuidv4(),
      name:           data.name.trim(),
      enabled:        true,
      priority:       data.priority !== undefined ? Number(data.priority) : this._nextPriority(),
      fwmark:         data.fwmark   !== undefined ? Number(data.fwmark)   : this._nextFwmark(),
      source:         this._normalizeEndpoint(data.source),
      destination:    this._normalizeEndpoint(data.destination, true),
      gatewayId:      data.gatewayId      || null,
      gatewayGroupId: data.gatewayGroupId || null,
      createdAt:      new Date().toISOString(),
    };

    await this._applyRule(rule);
    this.rules.push(rule);
    await this._save();

    debug(`Policy rule added: "${rule.name}" fwmark=${rule.fwmark}`);
    return rule;
  }

  /**
   * Обновить правило. Удаляет старый kernel-стек, применяет новый.
   *
   * @param {string} id
   * @param {object} data
   * @returns {Promise<object>}
   */
  async updateRule(id, data) {
    const idx = this.rules.findIndex(r => r.id === id);
    if (idx === -1) throw createError({ status: 404, message: `Policy rule ${id} not found` });

    const old = this.rules[idx];
    this._validateRule(data);

    const updated = {
      ...old,
      name:           data.name.trim(),
      priority:       data.priority !== undefined ? Number(data.priority) : old.priority,
      source:         this._normalizeEndpoint(data.source),
      destination:    this._normalizeEndpoint(data.destination, true),
      gatewayId:      data.gatewayId      !== undefined ? (data.gatewayId || null)      : old.gatewayId,
      gatewayGroupId: data.gatewayGroupId !== undefined ? (data.gatewayGroupId || null) : old.gatewayGroupId,
    };

    // Удалить старый kernel-стек
    if (old.enabled) {
      await this._removeRule(old).catch(err =>
        debug(`Remove old rule kernel stack: ${err.message}`)
      );
    }

    // Применить новый (если enabled)
    if (updated.enabled) {
      await this._applyRule(updated);
    }

    this.rules.splice(idx, 1, updated);
    await this._save();

    debug(`Policy rule updated: ${id}`);
    return updated;
  }

  /**
   * Удалить правило.
   *
   * @param {string} id
   */
  async deleteRule(id) {
    const idx = this.rules.findIndex(r => r.id === id);
    if (idx === -1) throw createError({ status: 404, message: `Policy rule ${id} not found` });

    const rule = this.rules[idx];
    if (rule.enabled) {
      await this._removeRule(rule).catch(err =>
        debug(`Remove rule kernel stack on delete: ${err.message}`)
      );
    }

    this.rules.splice(idx, 1);
    await this._save();
    debug(`Policy rule deleted: ${id}`);
  }

  /**
   * Включить / выключить правило.
   *
   * @param {string}  id
   * @param {boolean} enabled
   * @returns {Promise<object>}
   */
  async toggleRule(id, enabled) {
    const rule = this.rules.find(r => r.id === id);
    if (!rule) throw createError({ status: 404, message: `Policy rule ${id} not found` });

    if (enabled && !rule.enabled) {
      await this._applyRule(rule);
    } else if (!enabled && rule.enabled) {
      await this._removeRule(rule).catch(err =>
        debug(`Remove rule kernel stack on disable: ${err.message}`)
      );
    }

    rule.enabled = enabled;
    await this._save();
    return rule;
  }

  /**
   * Получить список всех правил.
   */
  getRules() {
    return this.rules;
  }

  // ─── Kernel operations ─────────────────────────────────────────────────────

  /**
   * Применить правило: mangle + ip route + ip rule.
   * Все операции идемпотентны.
   */
  async _applyRule(rule) {
    const gw = await this._resolveGateway(rule);

    // 1. iptables mangle: пометить пакеты
    const mangleCmds = this._buildMangleCmds(rule, 'A');
    for (const cmd of mangleCmds) {
      const checkCmd = cmd.replace(' -A ', ' -C ');
      try {
        await Util.exec(checkCmd, { log: false, timeout: 5000 });
        debug(`Mangle rule already in kernel: ${cmd}`);
      } catch {
        await Util.exec(cmd, { timeout: 10000 });
        debug(`Mangle rule applied: ${cmd}`);
      }
    }

    // 2. ip route: default gateway в таблице N
    const routeExists = await this._routeTableHasDefault(rule.fwmark);
    if (!routeExists) {
      const routeCmd = `ip route add default via ${gw.gatewayIP} dev ${gw.interface} table ${rule.fwmark}`;
      try {
        await Util.exec(routeCmd, { timeout: 10000 });
        debug(`Route added: ${routeCmd}`);
      } catch (err) {
        debug(`ip route add (may exist): ${err.message}`);
      }
    }

    // 3. ip rule: fwmark → lookup table
    const ruleExists = await this._ipRuleExists(rule.fwmark, rule.priority);
    if (!ruleExists) {
      const ruleCmd = `ip rule add fwmark ${rule.fwmark} lookup ${rule.fwmark} priority ${rule.priority}`;
      await Util.exec(ruleCmd, { timeout: 10000 });
      debug(`ip rule added: ${ruleCmd}`);
    }
  }

  /**
   * Удалить kernel-стек правила (обратный порядок).
   */
  async _removeRule(rule) {
    // 3. ip rule
    try {
      await Util.exec(
        `ip rule del fwmark ${rule.fwmark} lookup ${rule.fwmark} priority ${rule.priority}`,
        { timeout: 10000 }
      );
    } catch (err) {
      debug(`ip rule del: ${err.message}`);
    }

    // 2. ip route table
    try {
      await Util.exec(`ip route flush table ${rule.fwmark}`, { timeout: 10000 });
    } catch (err) {
      debug(`ip route flush table ${rule.fwmark}: ${err.message}`);
    }

    // 1. iptables mangle
    const mangleCmds = this._buildMangleCmds(rule, 'D');
    for (const cmd of mangleCmds) {
      try {
        await Util.exec(cmd, { timeout: 10000 });
      } catch (err) {
        debug(`Mangle remove (may not exist): ${err.message}`);
      }
    }
  }

  // ─── Build iptables commands ───────────────────────────────────────────────

  /**
   * Построить массив iptables-nft mangle команд для правила.
   *
   * Если source или destination — CIDR-алиас с несколькими записями,
   * генерируем по одному правилу на каждый CIDR (iptables не поддерживает списки).
   * Если тип — ipset, используем -m set --match-set.
   *
   * @param {object}  rule
   * @param {'A'|'D'} action
   * @returns {string[]}
   */
  _buildMangleCmds(rule, action) {
    const srcParts = this._buildMatchParts('src', rule.source);
    const dstParts = this._buildMatchParts('dst', rule.destination);

    const cmds = [];

    // Декартово произведение src × dst (обычно 1×1, но может быть N×M для CIDR-списков)
    for (const srcPart of srcParts) {
      for (const dstPart of dstParts) {
        let cmd = `iptables-nft -t mangle -${action} PREROUTING`;
        if (srcPart) cmd += ` ${srcPart}`;
        if (dstPart) cmd += ` ${dstPart}`;
        cmd += ` -j MARK --set-mark ${rule.fwmark}`;
        cmds.push(cmd);
      }
    }

    return cmds;
  }

  /**
   * Построить iptables-матч для одного endpoint (source или destination).
   *
   * @param {'src'|'dst'} dir
   * @param {object}      ep   - endpoint объект из правила
   * @returns {string[]} массив строк-частей команды
   */
  _buildMatchParts(dir, ep) {
    const flag  = dir === 'src' ? '-s' : '-d';
    const invert = ep.invert ? '! ' : '';

    if (ep.type === 'any') {
      return [''];  // нет ограничений — одно пустое правило
    }

    if (ep.type === 'cidr') {
      return [`${invert}${flag} ${ep.value}`];
    }

    if (ep.type === 'alias') {
      const spec = this._aliasMgr.getMatchSpec(ep.aliasId);
      if (spec.type === 'ipset') {
        const inv = ep.invert ? '! ' : '';
        return [`-m set ${inv}--match-set ${spec.name} ${dir}`];
      }
      // CIDR-алиас: одна запись на CIDR
      if (!spec.entries || spec.entries.length === 0) {
        debug(`Alias ${ep.aliasId} has no entries, skipping match`);
        return [''];
      }
      return spec.entries.map(cidr => `${invert}${flag} ${cidr}`);
    }

    return [''];
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Получить gateway объект (gatewayId или tier-1 из gatewayGroupId).
   */
  async _resolveGateway(rule) {
    if (rule.gatewayId) {
      const gw = this._gatewayMgr.getGateway(rule.gatewayId);
      if (!gw) throw new Error(`Gateway ${rule.gatewayId} not found`);
      return { gatewayIP: gw.data.gatewayIP, interface: gw.data.interface };
    }

    if (rule.gatewayGroupId) {
      const grp = this._gatewayMgr.getGroup(rule.gatewayGroupId);
      if (!grp) throw new Error(`GatewayGroup ${rule.gatewayGroupId} not found`);
      // Использовать gateway из наименьшего tier (tier 1 = наивысший приоритет)
      const sorted = [...grp.data.gateways].sort((a, b) => a.tier - b.tier);
      if (!sorted.length) throw new Error(`GatewayGroup ${rule.gatewayGroupId} has no gateways`);
      const gw = this._gatewayMgr.getGateway(sorted[0].gatewayId);
      if (!gw) throw new Error(`Gateway ${sorted[0].gatewayId} not found in group`);
      return { gatewayIP: gw.data.gatewayIP, interface: gw.data.interface };
    }

    throw new Error('Policy rule must have gatewayId or gatewayGroupId');
  }

  /**
   * Проверить, есть ли уже default route в таблице N.
   * @param {number} tableN
   * @returns {Promise<boolean>}
   */
  async _routeTableHasDefault(tableN) {
    try {
      const out = await Util.exec(`ip route show table ${tableN}`, { log: false, timeout: 5000 });
      return (out || '').includes('default');
    } catch {
      return false;
    }
  }

  /**
   * Проверить, существует ли ip rule с данным fwmark.
   * @param {number} fwmark
   * @param {number} priority
   * @returns {Promise<boolean>}
   */
  async _ipRuleExists(fwmark, priority) {
    try {
      const out = await Util.exec('ip rule show', { log: false, timeout: 5000 });
      // Ищем строку вида: "100:	from all fwmark 0x3e8 lookup 1000"
      const hexMark = `0x${fwmark.toString(16)}`;
      return (out || '').includes(`fwmark ${hexMark}`) ||
             (out || '').includes(`fwmark ${fwmark} `);
    } catch {
      return false;
    }
  }

  /**
   * Нормализовать endpoint объект (source / destination).
   * @param {object}  ep
   * @param {boolean} [isDst=false] — для destination добавляем поле invert
   * @returns {object}
   */
  _normalizeEndpoint(ep, isDst = false) {
    if (!ep || ep.type === 'any') {
      return { type: 'any', invert: false };
    }
    const base = {
      type:   ep.type,
      invert: isDst ? Boolean(ep.invert) : false,
    };
    if (ep.type === 'cidr')  return { ...base, value:   (ep.value || '').trim() };
    if (ep.type === 'alias') return { ...base, aliasId: ep.aliasId };
    return { type: 'any', invert: false };
  }

  /**
   * Валидация входных данных правила.
   */
  _validateRule(data) {
    if (!data.name || !data.name.trim()) {
      throw createError({ status: 400, message: 'Rule name is required' });
    }
    if (!data.gatewayId && !data.gatewayGroupId) {
      throw createError({ status: 400, message: 'Gateway or gateway group is required' });
    }
    if (data.source && data.source.type === 'cidr' && !data.source.value) {
      throw createError({ status: 400, message: 'Source CIDR value is required' });
    }
    if (data.destination && data.destination.type === 'cidr' && !data.destination.value) {
      throw createError({ status: 400, message: 'Destination CIDR value is required' });
    }
    if (data.priority !== undefined) {
      const p = Number(data.priority);
      if (isNaN(p) || p < 1 || p > 32000) {
        throw createError({ status: 400, message: 'Priority must be between 1 and 32000' });
      }
    }
    if (data.fwmark !== undefined) {
      const m = Number(data.fwmark);
      if (isNaN(m) || m < 1000 || m > 32000) {
        throw createError({ status: 400, message: 'fwmark must be between 1000 and 32000' });
      }
      // Проверить коллизию с существующим fwmark
      const collision = this.rules.find(r => r.fwmark === m && r.id !== data.id);
      if (collision) {
        throw createError({ status: 409, message: `fwmark ${m} is already used by rule "${collision.name}"` });
      }
    }
  }

  /** Следующий свободный fwmark (начиная с 1000, шаг 1). */
  _nextFwmark() {
    const used = new Set(this.rules.map(r => r.fwmark));
    let m = 1000;
    while (used.has(m)) m++;
    return m;
  }

  /** Следующий приоритет ip rule (начиная с 100, шаг 10). */
  _nextPriority() {
    if (!this.rules.length) return 100;
    return Math.max(...this.rules.map(r => r.priority)) + 10;
  }

  async _save() {
    await fs.writeFile(DATA_FILE, JSON.stringify(this.rules, null, 2));
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let instance = null;
let instanceReady = null;

module.exports = {
  getInstance: async () => {
    if (!instance) {
      instance      = new PolicyManager();
      instanceReady = instance.init();
    }
    await instanceReady;
    return instance;
  },
};
