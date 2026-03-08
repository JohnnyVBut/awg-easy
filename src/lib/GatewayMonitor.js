'use strict';

const Util = require('./Util');
const debug = require('debug')('awg:GatewayMonitor');

/**
 * GatewayMonitor — singleton, запускает ping-цикл для каждого gateway.
 * Результаты хранятся в памяти (не персистируются).
 */
class GatewayMonitor {
  constructor() {
    // gatewayId → { status, latency, packetLoss, lastCheck }
    this.statuses = new Map();
    // gatewayId → NodeJS.Timeout (setInterval handle)
    this.timers = new Map();
  }

  /**
   * Запустить мониторинг для конкретного gateway.
   * Если мониторинг уже запущен — перезапустить.
   */
  start(gateway) {
    // Остановить старый цикл если есть
    this.stop(gateway.id);

    if (!gateway.data.enabled || !gateway.data.monitor) {
      debug(`Gateway ${gateway.id}: monitoring disabled — skip start`);
      return;
    }

    debug(`Gateway ${gateway.id}: starting monitor (interval=${gateway.data.monitorInterval}s)`);

    // Немедленно первый пинг
    this._ping(gateway);

    // Затем по расписанию
    const timer = setInterval(
      () => this._ping(gateway),
      gateway.data.monitorInterval * 1000
    );
    this.timers.set(gateway.id, timer);
  }

  /**
   * Остановить мониторинг и удалить статус для gateway.
   */
  stop(gatewayId) {
    const t = this.timers.get(gatewayId);
    if (t) {
      clearInterval(t);
      this.timers.delete(gatewayId);
      debug(`Gateway ${gatewayId}: monitor stopped`);
    }
    this.statuses.delete(gatewayId);
  }

  /**
   * Выполнить один ping-цикл и обновить статус.
   * Не выбрасывает исключений — все ошибки → offline.
   */
  async _ping(gateway) {
    const { interface: iface, address, latencyThreshold, lossThreshold } = gateway.data;

    try {
      // -c 5: 5 пакетов, -W 1: таймаут 1с на пакет, -I: форсировать интерфейс
      const out = await Util.exec(
        `ping -c 5 -W 1 -I ${iface} ${address}`,
        { timeout: 10000, log: false }
      );

      // Парсинг packet loss: "X% packet loss"
      const lm = out.match(/(\d+)% packet loss/);
      const packetLoss = lm ? parseInt(lm[1], 10) : 100;

      // Парсинг среднего RTT (avg).
      // Linux iproute2: "rtt min/avg/max/mdev = X/AVG/X/X ms"
      // Alpine busybox:  "round-trip min/avg/max = X/AVG/X ms"
      // Матчим оба формата: ищем первое совпадение min/avg в строке с = X/AVG.
      const rm = out.match(/(?:rtt|round-trip)[^\n]+=\s*[\d.]+\/([\d.]+)\//);
      const latency = rm ? Math.round(parseFloat(rm[1])) : null;

      let status = 'online';
      if (packetLoss === 100) {
        status = 'offline';
      } else if (packetLoss >= lossThreshold || (latency !== null && latency >= latencyThreshold)) {
        status = 'degraded';
      }

      this.statuses.set(gateway.id, {
        status,
        latency,
        packetLoss,
        lastCheck: new Date().toISOString(),
      });

      debug(`Gateway ${gateway.id}: ${status} | RTT=${latency}ms | loss=${packetLoss}%`);
    } catch (err) {
      debug(`Gateway ${gateway.id}: ping failed — ${err.message}`);
      this.statuses.set(gateway.id, {
        status: 'offline',
        latency: null,
        packetLoss: 100,
        lastCheck: new Date().toISOString(),
      });
    }
  }

  /**
   * Получить текущий статус gateway.
   * Если мониторинг не запущен — возвращает unknown.
   */
  getStatus(gatewayId) {
    return this.statuses.get(gatewayId) || {
      status: 'unknown',
      latency: null,
      packetLoss: null,
      lastCheck: null,
    };
  }
}

// Singleton
let instance = null;

module.exports = {
  getInstance() {
    if (!instance) {
      instance = new GatewayMonitor();
    }
    return instance;
  },
};
