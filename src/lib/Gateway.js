'use strict';

const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const debug = require('debug')('awg:Gateway');

const GATEWAYS_DIR = '/etc/wireguard/data/gateways';

/**
 * Gateway — мониторируемый шлюз (аналог pfSense/OPNsense gateway)
 */
class Gateway {
  constructor(data) {
    this.id = data.id || uuidv4();
    this.data = {
      name:            data.name            || '',
      interface:       data.interface       || '',   // сетевой интерфейс (eth0, wg10, ...)
      address:         data.address         || '',   // IP-адрес для пинга
      enabled:         data.enabled         !== false,
      monitor:         data.monitor         !== false,
      monitorInterval: data.monitorInterval || 5,   // секунды между пробами (ping -c 1)
      windowSeconds:   data.windowSeconds   || 60,  // размер скользящего окна в секундах
      description:     data.description     || '',
      createdAt:       data.createdAt       || new Date().toISOString(),
    };
  }

  get filePath() {
    return `${GATEWAYS_DIR}/${this.id}.json`;
  }

  async save() {
    await fs.mkdir(GATEWAYS_DIR, { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2));
    debug(`Gateway ${this.id} saved`);
  }

  async delete() {
    await fs.unlink(this.filePath).catch(() => {});
    debug(`Gateway ${this.id} deleted`);
  }

  toJSON() {
    return { id: this.id, ...this.data };
  }

  static async load(id) {
    const raw = await fs.readFile(`${GATEWAYS_DIR}/${id}.json`, 'utf8');
    return new Gateway({ id, ...JSON.parse(raw) });
  }
}

module.exports = Gateway;
