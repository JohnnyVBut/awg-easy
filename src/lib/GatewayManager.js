'use strict';

const fs = require('fs').promises;
const Gateway = require('./Gateway');
const GatewayGroup = require('./GatewayGroup');
const GatewayMonitor = require('./GatewayMonitor');
const debug = require('debug')('awg:GatewayManager');

const GATEWAYS_DIR = '/etc/wireguard/data/gateways';
const GROUPS_DIR   = '/etc/wireguard/data/gateway-groups';

/**
 * GatewayManager — singleton, управляет CRUD для Gateway и GatewayGroup,
 * а также запускает GatewayMonitor для каждого активного gateway.
 */
class GatewayManager {
  constructor() {
    this.gateways = new Map(); // id → Gateway
    this.groups   = new Map(); // id → GatewayGroup
    this.monitor  = GatewayMonitor.getInstance();
  }

  /**
   * Инициализация: создать директории + загрузить данные с диска + запустить мониторинг.
   */
  async init() {
    debug('Initializing GatewayManager...');

    await fs.mkdir(GATEWAYS_DIR, { recursive: true });
    await fs.mkdir(GROUPS_DIR,   { recursive: true });

    // Загрузить gateways
    const gwFiles = await fs.readdir(GATEWAYS_DIR).catch(() => []);
    for (const f of gwFiles.filter(f => f.endsWith('.json'))) {
      try {
        const gw = await Gateway.load(f.replace('.json', ''));
        this.gateways.set(gw.id, gw);
        this.monitor.start(gw);
        debug(`Loaded gateway: ${gw.id} (${gw.data.name})`);
      } catch (err) {
        debug(`Error loading gateway ${f}: ${err.message}`);
      }
    }

    // Загрузить gateway groups
    const grpFiles = await fs.readdir(GROUPS_DIR).catch(() => []);
    for (const f of grpFiles.filter(f => f.endsWith('.json'))) {
      try {
        const grp = await GatewayGroup.load(f.replace('.json', ''));
        this.groups.set(grp.id, grp);
        debug(`Loaded gateway group: ${grp.id} (${grp.data.name})`);
      } catch (err) {
        debug(`Error loading gateway group ${f}: ${err.message}`);
      }
    }

    debug(`GatewayManager ready: ${this.gateways.size} gateways, ${this.groups.size} groups`);
  }

  // ─── Gateways ─────────────────────────────────────────────────────────────

  /**
   * Создать новый gateway.
   */
  async createGateway(data) {
    const gw = new Gateway(data);
    await gw.save();
    this.gateways.set(gw.id, gw);
    this.monitor.start(gw);
    debug(`Gateway created: ${gw.id}`);
    return gw;
  }

  /**
   * Обновить существующий gateway.
   */
  async updateGateway(id, updates) {
    const gw = this.gateways.get(id);
    if (!gw) throw new Error(`Gateway ${id} not found`);

    Object.assign(gw.data, updates);
    await gw.save();

    // Перезапустить мониторинг с новыми параметрами
    this.monitor.start(gw);

    debug(`Gateway updated: ${id}`);
    return gw;
  }

  /**
   * Удалить gateway и остановить его мониторинг.
   */
  async deleteGateway(id) {
    const gw = this.gateways.get(id);
    if (!gw) throw new Error(`Gateway ${id} not found`);

    this.monitor.stop(id);
    await gw.delete();
    this.gateways.delete(id);

    debug(`Gateway deleted: ${id}`);
  }

  getGateway(id) {
    return this.gateways.get(id);
  }

  getAllGateways() {
    return Array.from(this.gateways.values());
  }

  /**
   * Обогатить toJSON() данными live-мониторинга.
   */
  _gatewayToAPI(gw) {
    return { ...gw.toJSON(), ...this.monitor.getStatus(gw.id) };
  }

  // ─── Gateway Groups ────────────────────────────────────────────────────────

  /**
   * Создать новую группу шлюзов.
   */
  async createGroup(data) {
    const grp = new GatewayGroup(data);
    await grp.save();
    this.groups.set(grp.id, grp);
    debug(`GatewayGroup created: ${grp.id}`);
    return grp;
  }

  /**
   * Обновить группу шлюзов.
   */
  async updateGroup(id, updates) {
    const grp = this.groups.get(id);
    if (!grp) throw new Error(`GatewayGroup ${id} not found`);

    Object.assign(grp.data, updates);
    await grp.save();

    debug(`GatewayGroup updated: ${id}`);
    return grp;
  }

  /**
   * Удалить группу шлюзов.
   */
  async deleteGroup(id) {
    const grp = this.groups.get(id);
    if (!grp) throw new Error(`GatewayGroup ${id} not found`);

    await grp.delete();
    this.groups.delete(id);

    debug(`GatewayGroup deleted: ${id}`);
  }

  getGroup(id) {
    return this.groups.get(id);
  }

  getAllGroups() {
    return Array.from(this.groups.values());
  }
}

// Singleton с instanceReady (аналог InterfaceManager — защита от race condition)
let instance = null;
let instanceReady = null;

module.exports = {
  getInstance: async () => {
    if (!instance) {
      instance = new GatewayManager();
      instanceReady = instance.init();
    }
    await instanceReady;
    return instance;
  },
};
