'use strict';

const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const debug = require('debug')('awg:GatewayGroup');

const GROUPS_DIR = '/etc/wireguard/data/gateway-groups';

/**
 * GatewayGroup — группа шлюзов с tier-based приоритетами (аналог pfSense Gateway Groups)
 */
class GatewayGroup {
  constructor(data) {
    this.id = data.id || uuidv4();
    this.data = {
      name:        data.name        || '',
      trigger:     data.trigger     || 'packetloss', // 'packetloss'|'latency'|'packetloss_latency'
      description: data.description || '',
      // Каждый элемент: { gatewayId, tier (1=highest priority), weight }
      gateways:    data.gateways    || [],
      createdAt:   data.createdAt   || new Date().toISOString(),
    };
  }

  get filePath() {
    return `${GROUPS_DIR}/${this.id}.json`;
  }

  async save() {
    await fs.mkdir(GROUPS_DIR, { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2));
    debug(`GatewayGroup ${this.id} saved`);
  }

  async delete() {
    await fs.unlink(this.filePath).catch(() => {});
    debug(`GatewayGroup ${this.id} deleted`);
  }

  toJSON() {
    return { id: this.id, ...this.data };
  }

  static async load(id) {
    const raw = await fs.readFile(`${GROUPS_DIR}/${id}.json`, 'utf8');
    return new GatewayGroup({ id, ...JSON.parse(raw) });
  }
}

module.exports = GatewayGroup;
