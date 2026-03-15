'use strict';

const fs         = require('fs');
const fsPromises = require('fs').promises;
const path       = require('path');
const { v4: uuidv4 } = require('uuid');
const { createError } = require('h3');
const Util          = require('./Util');
const GatewayManager = require('./GatewayManager');
const AliasManager  = require('./AliasManager');
const debug         = require('debug')('awg:FirewallManager');

const DATA_FILE       = '/etc/wireguard/data/firewall-rules.json';
const OLD_POLICY_FILE = '/etc/wireguard/data/policy-rules.json';

/**
 * FirewallManager — управление Firewall Rules (поглощает PBR / PolicyManager).
 *
 * Каждое правило генерирует iptables-nft команды в custom chains:
 *
 *   FIREWALL_FORWARD (filter table) — всегда, для ACCEPT/DROP/REJECT
 *   FIREWALL_MANGLE  (mangle table) — только для правил с gateway (PBR marking)
 *
 * Правила применяются в порядке поля `order` (первое совпадение побеждает).
 * После любого изменения — полная перестройка цепочек (_rebuildChains).
 *
 * Модель правила:
 * {
 *   id, name, enabled, order,
 *   interface:    'any'|'wg10'|'eth0'  — ingress -i флаг
 *   protocol:     'any'|'tcp'|'udp'|'tcp/udp'|'icmp'
 *   source:       { type, aliasId?, value?, invert, port? }
 *   destination:  { type, aliasId?, value?, invert, port? }
 *   action:       'accept'|'drop'|'reject'
 *   gatewayId:    string|null   — PBR: route via gateway (только с action=accept)
 *   gatewayGroupId: string|null
 *   fwmark:       number|null   — auto-assigned когда есть gateway
 *   log:          boolean
 *   comment:      string
 *   createdAt:    ISO string
 * }
 */
class FirewallManager {

  constructor() {
    /** @type {object[]} */
    this._rules      = [];
    this._aliasMgr   = null;
    this._gatewayMgr = null;

    // Fallback state tracking (in-memory, not persisted)
    this._fallbackActive  = new Set();   // rule IDs currently in fallback/blackhole
    this._restoreTimers   = new Map();   // rule ID → setTimeout handle (30s restore delay)
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async init() {
    debug('Initializing FirewallManager...');
    await fsPromises.mkdir(path.dirname(DATA_FILE), { recursive: true });

    this._aliasMgr   = await AliasManager.getInstance();
    this._gatewayMgr = await GatewayManager.getInstance();

    // Создать custom chains (идемпотентно)
    await this._initChains();

    // Мигрировать policy-rules.json → firewall-rules.json (если нужно)
    await this._migrate();

    // Загрузить правила с диска
    try {
      const json = await fsPromises.readFile(DATA_FILE, 'utf8');
      this._rules = JSON.parse(json);
      debug(`Loaded ${this._rules.length} firewall rules`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this._rules = [];
      debug('No firewall-rules.json, starting fresh');
    }

    // Восстановить правила в ядро
    await this._rebuildChains();

    // Подписаться на смену статуса gateway для fallback-логики
    const GatewayMonitor = require('./GatewayMonitor');
    const monitor = GatewayMonitor.getInstance();
    monitor.on('statusChange', (gatewayId, newStatus, oldStatus) => {
      this._handleGatewayStatusChange(gatewayId, newStatus, oldStatus).catch(err =>
        debug(`_handleGatewayStatusChange error: ${err.message}`)
      );
    });

    debug('FirewallManager ready');
  }

  // ─── Custom chains init ────────────────────────────────────────────────────

  async _initChains() {
    // filter: FORWARD → FIREWALL_FORWARD
    await Util.exec('iptables-nft -t filter -N FIREWALL_FORWARD 2>/dev/null || true', { timeout: 5000 })
      .catch(err => debug(`Create filter chain: ${err.message}`));
    try {
      await Util.exec('iptables-nft -t filter -C FORWARD -j FIREWALL_FORWARD', { log: false, timeout: 5000 });
    } catch {
      await Util.exec('iptables-nft -t filter -I FORWARD 1 -j FIREWALL_FORWARD', { timeout: 5000 })
        .catch(err => debug(`Hook filter chain: ${err.message}`));
    }

    // mangle: PREROUTING → FIREWALL_MANGLE
    await Util.exec('iptables-nft -t mangle -N FIREWALL_MANGLE 2>/dev/null || true', { timeout: 5000 })
      .catch(err => debug(`Create mangle chain: ${err.message}`));
    try {
      await Util.exec('iptables-nft -t mangle -C PREROUTING -j FIREWALL_MANGLE', { log: false, timeout: 5000 });
    } catch {
      await Util.exec('iptables-nft -t mangle -I PREROUTING 1 -j FIREWALL_MANGLE', { timeout: 5000 })
        .catch(err => debug(`Hook mangle chain: ${err.message}`));
    }

    debug('Custom chains initialized');
  }

  // ─── Full rebuild ───────────────────────────────────────────────────────────

  /**
   * Полная перестройка: flush chains → cleanup routing → re-apply all enabled rules.
   * Вызывается после каждого изменения.
   * После rebuild fallback-состояние сбрасывается — GatewayMonitor переподтвердит
   * статусы и вызовет fallback снова если нужно.
   */
  async _rebuildChains() {
    // Сбросить fallback-состояние (маршруты будут перезаписаны через ip route replace)
    for (const timer of this._restoreTimers.values()) clearTimeout(timer);
    this._restoreTimers.clear();
    this._fallbackActive.clear();

    // Flush custom chains
    await Util.exec('iptables-nft -t filter -F FIREWALL_FORWARD', { timeout: 5000 })
      .catch(err => debug(`Flush filter: ${err.message}`));
    await Util.exec('iptables-nft -t mangle -F FIREWALL_MANGLE', { timeout: 5000 })
      .catch(err => debug(`Flush mangle: ${err.message}`));

    // Убрать все ip rule + ip route которые мы когда-либо создавали
    await this._cleanupRoutingRules();

    // Применить все enabled правила в порядке order asc
    const sorted = [...this._rules].filter(r => r.enabled).sort((a, b) => a.order - b.order);
    for (const rule of sorted) {
      try {
        await this._applyRuleKernel(rule);
      } catch (err) {
        debug(`Failed to apply rule "${rule.name}": ${err.message}`);
      }
    }
    debug(`Chains rebuilt: ${sorted.length} active rules`);
  }

  /** Удалить все ip rule + ip route table для правил с fwmark. */
  async _cleanupRoutingRules() {
    const withMark = this._rules.filter(r => r.fwmark);
    for (const rule of withMark) {
      await Util.exec(`ip rule del fwmark ${rule.fwmark} lookup ${rule.fwmark}`, { log: false, timeout: 5000 })
        .catch(() => {});
      await Util.exec(`ip route flush table ${rule.fwmark}`, { log: false, timeout: 5000 })
        .catch(() => {});
    }
  }

  // ─── Apply single rule to kernel ────────────────────────────────────────────

  async _applyRuleKernel(rule) {
    const protocols = this._expandProtocol(rule.protocol);
    const srcParts  = this._buildMatchParts('src', rule.source);
    const dstParts  = this._buildMatchParts('dst', rule.destination);

    // Настроить PBR routing (один раз per rule, вне цикла proto×src×dst)
    if (rule.action === 'accept' && (rule.gatewayId || rule.gatewayGroupId)) {
      await this._applyRoutingForRule(rule);
    }

    // Создать iptables правила: декартово произведение proto × src × dst
    for (const proto of protocols) {
      for (const srcPart of srcParts) {
        for (const dstPart of dstParts) {
          const matchFlags = this._buildMatchFlags(rule, proto, srcPart, dstPart);

          // Опциональный LOG
          if (rule.log) {
            const logCmd = `iptables-nft -t filter -A FIREWALL_FORWARD${matchFlags} -j LOG --log-prefix "FW: "`;
            await Util.exec(logCmd, { timeout: 10000 })
              .catch(err => debug(`Log rule: ${err.message}`));
          }

          // Mangle MARK (для PBR правил)
          if (rule.action === 'accept' && (rule.gatewayId || rule.gatewayGroupId)) {
            const mangleCmd = `iptables-nft -t mangle -A FIREWALL_MANGLE${matchFlags} -j MARK --set-mark ${rule.fwmark}`;
            await Util.exec(mangleCmd, { timeout: 10000 })
              .catch(err => debug(`Mangle rule: ${err.message}`));
          }

          // Filter action
          const target = rule.action === 'reject'
            ? 'REJECT --reject-with icmp-port-unreachable'
            : rule.action === 'drop' ? 'DROP' : 'ACCEPT';
          const filterCmd = `iptables-nft -t filter -A FIREWALL_FORWARD${matchFlags} -j ${target}`;
          await Util.exec(filterCmd, { timeout: 10000 });
        }
      }
    }
  }

  /**
   * Применить ip route + ip rule для PBR правила.
   * Использует replace (не add) — безопасно перезаписывает stale fallback/blackhole маршруты.
   */
  async _applyRoutingForRule(rule) {
    const gw = await this._resolveGateway(rule);

    // ip route replace default via <gw> dev <iface> table <fwmark>
    // replace идемпотентен: создаёт если нет, перезаписывает если есть (в т.ч. fallback-маршрут)
    await Util.exec(
      `ip route replace default via ${gw.gatewayIP} dev ${gw.interface} table ${rule.fwmark}`,
      { timeout: 10000 }
    );
    debug(`Route set: table ${rule.fwmark} via ${gw.gatewayIP} dev ${gw.interface}`);

    // ip rule add fwmark <fwmark> lookup <fwmark> priority <priority>
    const ipRuleExists = await this._ipRuleExists(rule.fwmark);
    if (!ipRuleExists) {
      const priority = 1000 + (rule.order || 1) * 10;
      await Util.exec(
        `ip rule add fwmark ${rule.fwmark} lookup ${rule.fwmark} priority ${priority}`,
        { timeout: 10000 }
      );
      debug(`ip rule added: fwmark ${rule.fwmark} priority ${priority}`);
    }
  }

  // ─── Match building ─────────────────────────────────────────────────────────

  /**
   * Построить строку флагов match для одной комбинации (proto, srcPart, dstPart).
   * Возвращает строку вида " -i wg10 -p tcp -s 10.0.0.0/8 --sport 80 -d 8.8.8.8 --dport 443"
   */
  _buildMatchFlags(rule, proto, srcPart, dstPart) {
    let s = '';
    if (rule.interface && rule.interface !== 'any') s += ` -i ${rule.interface}`;
    if (proto)   s += ` -p ${proto}`;
    if (srcPart) s += ` ${srcPart}`;
    const sp = this._portFlag('--sport', rule.source?.port, proto);
    if (sp) s += ` ${sp}`;
    if (dstPart) s += ` ${dstPart}`;
    const dp = this._portFlag('--dport', rule.destination?.port, proto);
    if (dp) s += ` ${dp}`;
    return s;
  }

  /**
   * Развернуть protocol в массив iptables-протоколов.
   * 'tcp/udp' → ['tcp', 'udp'] (два отдельных правила)
   * 'any'     → [null] (нет флага -p)
   */
  _expandProtocol(protocol) {
    if (!protocol || protocol === 'any') return [null];
    if (protocol === 'tcp/udp')           return ['tcp', 'udp'];
    return [protocol]; // tcp, udp, icmp
  }

  /**
   * Построить флаг порта (--sport / --dport).
   * port format: "80" | "443" | "8080-8090" | "80,443"
   * Требует proto=tcp или proto=udp.
   */
  _portFlag(flag, port, proto) {
    if (!port || !String(port).trim()) return null;
    if (proto !== 'tcp' && proto !== 'udp') return null; // icmp/any не поддерживает порты
    const normalized = String(port).trim().replace(/-/, ':'); // "8080-8090" → "8080:8090"
    if (normalized.includes(',')) {
      return `-m multiport ${flag}s ${normalized}`; // --sports / --dports
    }
    return `${flag} ${normalized}`;
  }

  /**
   * Построить массив match-частей для endpoint (src или dst).
   * Возвращает массив строк — одна строка на CIDR/правило.
   *
   * @param {'src'|'dst'} dir
   * @param {object}      ep
   * @returns {string[]}
   */
  _buildMatchParts(dir, ep) {
    const flag   = dir === 'src' ? '-s' : '-d';
    const invert = ep?.invert ? '! ' : '';

    if (!ep || ep.type === 'any') return [''];

    if (ep.type === 'cidr') {
      return [`${invert}${flag} ${ep.value}`];
    }

    if (ep.type === 'alias') {
      const spec = this._aliasMgr.getMatchSpec(ep.aliasId);
      if (spec.type === 'ipset') {
        const inv = ep.invert ? '! ' : '';
        return [`-m set ${inv}--match-set ${spec.name} ${dir}`];
      }
      // CIDR-алиас: одно правило на каждый CIDR
      if (!spec.entries || spec.entries.length === 0) {
        debug(`Alias ${ep.aliasId} has no entries, skipping match`);
        return [''];
      }
      return spec.entries.map(cidr => `${invert}${flag} ${cidr}`);
    }

    return [''];
  }

  // ─── Public CRUD ───────────────────────────────────────────────────────────

  async addRule(data) {
    this._validateRule(data);
    const hasGateway = !!(data.gatewayId || data.gatewayGroupId);

    const rule = {
      id:               uuidv4(),
      name:             data.name.trim(),
      enabled:          true,
      order:            this._nextOrder(),
      interface:        data.interface || 'any',
      protocol:         data.protocol  || 'any',
      source:           this._normalizeEndpoint(data.source, 'src'),
      destination:      this._normalizeEndpoint(data.destination, 'dst'),
      action:           data.action || 'accept',
      gatewayId:        data.gatewayId      || null,
      gatewayGroupId:   data.gatewayGroupId || null,
      fwmark:           hasGateway
        ? (data.fwmark ? Number(data.fwmark) : this._nextFwmark())
        : null,
      fallbackToDefault: hasGateway ? Boolean(data.fallbackToDefault) : false,
      log:              Boolean(data.log),
      comment:          data.comment || '',
      createdAt:        new Date().toISOString(),
    };

    this._rules.push(rule);
    await this._save();
    await this._rebuildChains();

    debug(`Rule added: "${rule.name}" action=${rule.action} order=${rule.order}`);
    return rule;
  }

  async updateRule(id, data) {
    const idx = this._rules.findIndex(r => r.id === id);
    if (idx === -1) throw createError({ status: 404, message: `Firewall rule ${id} not found` });

    this._validateRule(data, id);
    const old = this._rules[idx];
    const hasGateway = !!(
      (data.gatewayId      !== undefined ? data.gatewayId      : old.gatewayId) ||
      (data.gatewayGroupId !== undefined ? data.gatewayGroupId : old.gatewayGroupId)
    );

    const updated = {
      ...old,
      name:              data.name.trim(),
      interface:         data.interface      !== undefined ? (data.interface  || 'any') : old.interface,
      protocol:          data.protocol       !== undefined ? (data.protocol   || 'any') : old.protocol,
      source:            this._normalizeEndpoint(data.source      || old.source, 'src'),
      destination:       this._normalizeEndpoint(data.destination || old.destination, 'dst'),
      action:            data.action         !== undefined ? data.action                : old.action,
      gatewayId:         data.gatewayId      !== undefined ? (data.gatewayId      || null) : old.gatewayId,
      gatewayGroupId:    data.gatewayGroupId !== undefined ? (data.gatewayGroupId || null) : old.gatewayGroupId,
      fwmark:            hasGateway
        ? (data.fwmark ? Number(data.fwmark) : (old.fwmark || this._nextFwmark()))
        : null,
      fallbackToDefault: hasGateway
        ? (data.fallbackToDefault !== undefined ? Boolean(data.fallbackToDefault) : Boolean(old.fallbackToDefault))
        : false,
      log:     data.log     !== undefined ? Boolean(data.log)    : old.log,
      comment: data.comment !== undefined ? (data.comment || '') : old.comment,
    };

    this._rules.splice(idx, 1, updated);
    await this._save();
    await this._rebuildChains();

    debug(`Rule updated: ${id}`);
    return updated;
  }

  async deleteRule(id) {
    const idx = this._rules.findIndex(r => r.id === id);
    if (idx === -1) throw createError({ status: 404, message: `Firewall rule ${id} not found` });

    this._rules.splice(idx, 1);
    await this._save();
    await this._rebuildChains();
    debug(`Rule deleted: ${id}`);
  }

  async toggleRule(id, enabled) {
    const rule = this._rules.find(r => r.id === id);
    if (!rule) throw createError({ status: 404, message: `Firewall rule ${id} not found` });

    rule.enabled = Boolean(enabled);
    await this._save();
    await this._rebuildChains();
    return rule;
  }

  /**
   * Переместить правило вверх или вниз (меняем order с соседом).
   * @param {string} id
   * @param {'up'|'down'} direction
   */
  async moveRule(id, direction) {
    const sorted = [...this._rules].sort((a, b) => a.order - b.order);
    const idx = sorted.findIndex(r => r.id === id);
    if (idx === -1) throw createError({ status: 404, message: `Firewall rule ${id} not found` });

    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sorted.length) {
      return this._rules.find(r => r.id === id); // уже на краю
    }

    // Swap order values
    const ruleA = this._rules.find(r => r.id === sorted[idx].id);
    const ruleB = this._rules.find(r => r.id === sorted[swapIdx].id);
    const tmp = ruleA.order;
    ruleA.order = ruleB.order;
    ruleB.order = tmp;

    await this._save();
    await this._rebuildChains();
    return ruleA;
  }

  /** Вернуть все правила, отсортированные по order. */
  getRules() {
    return [...this._rules].sort((a, b) => a.order - b.order);
  }

  /** Список сетевых интерфейсов хоста (для выбора в UI). */
  async getNetworkInterfaces() {
    try {
      const out = await Util.exec('ip -o link show', { log: false, timeout: 5000 });
      const ifaces = [];
      for (const line of (out || '').split('\n')) {
        const m = line.match(/^\d+:\s+(\S+?)(?:@\S+)?:/);
        if (m && m[1] !== 'lo') ifaces.push({ name: m[1] });
      }
      return ifaces;
    } catch (err) {
      debug(`getNetworkInterfaces: ${err.message}`);
      return [];
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  async _resolveGateway(rule) {
    if (rule.gatewayId) {
      const gw = this._gatewayMgr.getGateway(rule.gatewayId);
      if (!gw) throw new Error(`Gateway ${rule.gatewayId} not found`);
      return { gatewayIP: gw.data.gatewayIP, interface: gw.data.interface };
    }
    if (rule.gatewayGroupId) {
      const grp = this._gatewayMgr.getGroup(rule.gatewayGroupId);
      if (!grp) throw new Error(`GatewayGroup ${rule.gatewayGroupId} not found`);
      const tiers = [...grp.data.gateways].sort((a, b) => a.tier - b.tier);
      if (!tiers.length) throw new Error(`GatewayGroup ${rule.gatewayGroupId} is empty`);
      const gw = this._gatewayMgr.getGateway(tiers[0].gatewayId);
      if (!gw) throw new Error(`Gateway ${tiers[0].gatewayId} not found in group`);
      return { gatewayIP: gw.data.gatewayIP, interface: gw.data.interface };
    }
    throw new Error('Rule with gateway requires gatewayId or gatewayGroupId');
  }

  async _routeTableHasDefault(tableN) {
    try {
      const out = await Util.exec(`ip route show table ${tableN}`, { log: false, timeout: 5000 });
      return (out || '').includes('default');
    } catch { return false; }
  }

  async _ipRuleExists(fwmark) {
    try {
      const out = await Util.exec('ip rule show', { log: false, timeout: 5000 });
      const hexMark = `0x${fwmark.toString(16)}`;
      return (out || '').includes(`fwmark ${hexMark}`) ||
             (out || '').includes(`fwmark ${fwmark} `);
    } catch { return false; }
  }

  /**
   * Нормализовать endpoint объект.
   * @param {object}    ep
   * @param {'src'|'dst'} dir
   */
  _normalizeEndpoint(ep, dir) {
    if (!ep || ep.type === 'any') {
      return { type: 'any', invert: false, port: null };
    }
    const base = {
      type:   ep.type,
      invert: dir === 'dst' ? Boolean(ep.invert) : false, // src invert не поддерживается
      port:   ep.port ? String(ep.port).trim() : null,
    };
    if (ep.type === 'cidr')  return { ...base, value:   (ep.value || '').trim() };
    if (ep.type === 'alias') return { ...base, aliasId: ep.aliasId };
    return { type: 'any', invert: false, port: null };
  }

  _validateRule(data, updateId = null) {
    if (!data.name || !String(data.name).trim()) {
      throw createError({ status: 400, message: 'Rule name is required' });
    }
    const validActions = ['accept', 'drop', 'reject'];
    if (data.action && !validActions.includes(data.action)) {
      throw createError({ status: 400, message: `Action must be one of: ${validActions.join(', ')}` });
    }
    if (data.source?.type === 'cidr' && !data.source.value) {
      throw createError({ status: 400, message: 'Source CIDR value is required' });
    }
    if (data.destination?.type === 'cidr' && !data.destination.value) {
      throw createError({ status: 400, message: 'Destination CIDR value is required' });
    }
    if (data.interface && data.interface !== 'any') {
      if (!/^[a-zA-Z0-9._-]+$/.test(data.interface)) {
        throw createError({ status: 400, message: 'Invalid interface name' });
      }
    }
    const validProtocols = ['any', 'tcp', 'udp', 'tcp/udp', 'icmp'];
    if (data.protocol && !validProtocols.includes(data.protocol)) {
      throw createError({ status: 400, message: `Protocol must be one of: ${validProtocols.join(', ')}` });
    }
  }

  _nextOrder() {
    if (!this._rules.length) return 1;
    return Math.max(...this._rules.map(r => r.order || 0)) + 1;
  }

  _nextFwmark() {
    const used = new Set(this._rules.filter(r => r.fwmark).map(r => r.fwmark));
    let m = 1000;
    while (used.has(m)) m++;
    return m;
  }

  // ─── Migration ─────────────────────────────────────────────────────────────

  /**
   * Мигрировать policy-rules.json → firewall-rules.json.
   * Выполняется один раз: только если policy-rules.json существует
   * и firewall-rules.json ещё не создан.
   */
  async _migrate() {
    if (!fs.existsSync(OLD_POLICY_FILE)) return;
    try {
      await fsPromises.access(DATA_FILE);
      return; // firewall-rules.json уже есть, пропускаем
    } catch { /* не существует — мигрируем */ }

    debug('Migrating policy-rules.json → firewall-rules.json...');
    try {
      const json = await fsPromises.readFile(OLD_POLICY_FILE, 'utf8');
      const old  = JSON.parse(json);
      this._rules = (Array.isArray(old) ? old : []).map((r, i) => ({
        id:             r.id || uuidv4(),
        name:           r.name || `Rule ${i + 1}`,
        enabled:        Boolean(r.enabled),
        order:          i + 1,
        interface:      'any',
        protocol:       'any',
        source:         { ...(r.source      || { type: 'any', invert: false }), port: null },
        destination:    { ...(r.destination || { type: 'any', invert: false }), port: null },
        action:         'accept',
        gatewayId:      r.gatewayId      || null,
        gatewayGroupId: r.gatewayGroupId || null,
        fwmark:         r.fwmark         || null,
        log:            false,
        comment:        '',
        createdAt:      r.createdAt || new Date().toISOString(),
      }));
      await this._save();
      await fsPromises.rename(OLD_POLICY_FILE, `${OLD_POLICY_FILE}.migrated`);
      debug(`Migrated ${this._rules.length} policy rules`);
    } catch (err) {
      debug(`Migration failed: ${err.message}`);
    }
  }

  async _save() {
    await fsPromises.writeFile(DATA_FILE, JSON.stringify(this._rules, null, 2));
  }

  // ─── Gateway Fallback Logic ─────────────────────────────────────────────────

  /**
   * Обработать смену статуса gateway.
   * Вызывается GatewayMonitor через событие 'statusChange'.
   *
   * @param {string} gatewayId
   * @param {string} newStatus   'healthy'|'degraded'|'down'|'unknown'
   * @param {string} oldStatus
   */
  async _handleGatewayStatusChange(gatewayId, newStatus, oldStatus) {
    const goingDown = newStatus === 'down' && oldStatus !== 'down';
    const comingUp  = newStatus !== 'down' && oldStatus === 'down';

    if (goingDown) {
      await this._onGatewayDown(gatewayId);
    } else if (comingUp) {
      await this._onGatewayUp(gatewayId);
    }
  }

  /**
   * Gateway упал — найти все PBR-правила которые его используют,
   * применить fallback или blackhole.
   */
  async _onGatewayDown(gatewayId) {
    debug(`Gateway ${gatewayId} went DOWN — checking PBR rules`);
    for (const rule of this._rules) {
      if (!rule.enabled || !rule.fwmark) continue;

      // Прямое использование gateway
      if (rule.gatewayId === gatewayId) {
        await this._triggerFallback(rule, `gateway ${gatewayId} down`);
        continue;
      }

      // Использование через группу — только если ВСЕ члены группы упали
      if (rule.gatewayGroupId) {
        const allDown = await this._isGroupAllDown(rule.gatewayGroupId);
        if (allDown) {
          await this._triggerFallback(rule, `all gateways in group ${rule.gatewayGroupId} down`);
        }
      }
    }
  }

  /**
   * Gateway поднялся — запланировать восстановление маршрутов через 30s.
   */
  async _onGatewayUp(gatewayId) {
    debug(`Gateway ${gatewayId} came UP — scheduling route restore in 30s`);
    for (const rule of this._rules) {
      if (!rule.enabled || !rule.fwmark) continue;
      if (!this._fallbackActive.has(rule.id)) continue;

      let shouldSchedule = false;

      if (rule.gatewayId === gatewayId) {
        shouldSchedule = true;
      }

      if (rule.gatewayGroupId) {
        // Восстанавливаем если хотя бы один member группы поднялся (т.е. уже не ALL down)
        const allDown = await this._isGroupAllDown(rule.gatewayGroupId);
        if (!allDown) shouldSchedule = true;
      }

      if (shouldSchedule) {
        // Отменить предыдущий таймер восстановления если есть
        const existing = this._restoreTimers.get(rule.id);
        if (existing) clearTimeout(existing);

        debug(`Rule "${rule.name}": scheduling restore in 30s`);
        const timer = setTimeout(async () => {
          this._restoreTimers.delete(rule.id);
          await this._restoreRoute(rule).catch(err =>
            debug(`_restoreRoute failed for rule "${rule.name}": ${err.message}`)
          );
        }, 30_000);
        this._restoreTimers.set(rule.id, timer);
      }
    }
  }

  /**
   * Применить fallback или blackhole для правила (в зависимости от fallbackToDefault).
   */
  async _triggerFallback(rule, reason) {
    if (this._fallbackActive.has(rule.id)) return; // уже в fallback-состоянии

    // Отменить pending restore если есть
    const existing = this._restoreTimers.get(rule.id);
    if (existing) { clearTimeout(existing); this._restoreTimers.delete(rule.id); }

    if (rule.fallbackToDefault) {
      // Переключить маршрут таблицы N на системный default gateway
      try {
        const { via, dev } = await this._getSystemDefaultGateway();
        await Util.exec(
          `ip route replace default via ${via} dev ${dev} table ${rule.fwmark}`,
          { timeout: 10000 }
        );
        this._fallbackActive.add(rule.id);
        debug(`Rule "${rule.name}": fallback ACTIVE → default via ${via} dev ${dev} (${reason})`);
      } catch (err) {
        debug(`Rule "${rule.name}": fallback failed: ${err.message}`);
      }
    } else {
      // Дропать трафик — blackhole маршрут
      try {
        await Util.exec(
          `ip route replace blackhole default table ${rule.fwmark}`,
          { timeout: 10000 }
        );
        this._fallbackActive.add(rule.id);
        debug(`Rule "${rule.name}": blackhole ACTIVE (${reason})`);
      } catch (err) {
        debug(`Rule "${rule.name}": blackhole failed: ${err.message}`);
      }
    }
  }

  /**
   * Восстановить оригинальный маршрут правила после возврата gateway.
   */
  async _restoreRoute(rule) {
    debug(`Rule "${rule.name}": restoring original route`);
    try {
      const gw = await this._resolveGateway(rule);
      await Util.exec(
        `ip route replace default via ${gw.gatewayIP} dev ${gw.interface} table ${rule.fwmark}`,
        { timeout: 10000 }
      );
      this._fallbackActive.delete(rule.id);
      debug(`Rule "${rule.name}": route RESTORED → via ${gw.gatewayIP} dev ${gw.interface}`);
    } catch (err) {
      debug(`Rule "${rule.name}": restore failed, staying in fallback: ${err.message}`);
      // Не удаляем из _fallbackActive — попробуем снова при следующем up-событии
    }
  }

  /**
   * Получить системный default gateway (для fallbackToDefault).
   * Парсит текстовый вывод `ip route show default`.
   */
  async _getSystemDefaultGateway() {
    const out = await Util.exec('ip route show default', { log: false, timeout: 5000 });
    // "default via 192.168.1.1 dev eth0 proto static metric 100"
    const m = (out || '').match(/default via (\S+) dev (\S+)/);
    if (!m) throw new Error('System default gateway not found');
    return { via: m[1], dev: m[2] };
  }

  /**
   * Проверить — ВСЕ ли участники gateway группы имеют статус 'down'.
   * Используется для определения момента fallback для группы.
   */
  async _isGroupAllDown(groupId) {
    const grp = this._gatewayMgr.getGroup(groupId);
    if (!grp || !grp.data.gateways || grp.data.gateways.length === 0) return true;

    const GatewayMonitor = require('./GatewayMonitor');
    const monitor = GatewayMonitor.getInstance();

    for (const member of grp.data.gateways) {
      const st = monitor.getStatus(member.gatewayId);
      if (st.status !== 'down') return false; // хотя бы один не down
    }
    return true; // все down
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let instance      = null;
let instanceReady = null;

module.exports = {
  getInstance: async () => {
    if (!instance) {
      instance      = new FirewallManager();
      instanceReady = instance.init();
    }
    await instanceReady;
    return instance;
  },
};
