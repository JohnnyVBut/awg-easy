'use strict';

const Util = require('./Util');
const debug = require('debug')('awg:GatewayMonitor');

// Status thresholds (packet success rate %)
const THRESHOLD_HEALTHY  = 95; // >= 95% → healthy
const THRESHOLD_DEGRADED = 90; // >= 90% && < 95% → degraded
                                //  < 90% → down
const MIN_PROBES = 3;           // need at least this many probes before committing to a status

/**
 * GatewayMonitor — singleton, запускает ping-цикл для каждого gateway.
 *
 * Логика: sliding window.
 *   - Каждый тик: ping -c 1 -W 1  →  один probe (success/fail + latency)
 *   - Window: последние windowSeconds секунд проб (хранится в памяти)
 *   - Success rate = (total - lost) / total * 100
 *   - >= THRESHOLD_HEALTHY  → 'healthy'
 *   - >= THRESHOLD_DEGRADED → 'degraded'
 *   - <  THRESHOLD_DEGRADED → 'down'
 *   - < MIN_PROBES samples  → 'unknown'
 *   Latency: скользящее среднее по успешным пробам в окне.
 */
class GatewayMonitor {
  constructor() {
    // gatewayId → { status, latency, packetLoss, lastCheck }
    this.statuses = new Map();
    // gatewayId → Array<{ ts: number, success: boolean, latency: number|null }>
    this.windows  = new Map();
    // gatewayId → NodeJS.Timeout
    this.timers   = new Map();
  }

  /**
   * Запустить мониторинг для конкретного gateway.
   * Если уже запущен — перезапустить (окно сбрасывается).
   */
  start(gateway) {
    this.stop(gateway.id);

    if (!gateway.data.enabled || !gateway.data.monitor) {
      debug(`Gateway ${gateway.id}: monitoring disabled — skip start`);
      return;
    }

    const interval = gateway.data.monitorInterval * 1000;
    debug(`Gateway ${gateway.id}: starting monitor (interval=${gateway.data.monitorInterval}s, window=${gateway.data.windowSeconds}s)`);

    // Немедленно первый probe
    this._probe(gateway);

    const timer = setInterval(() => this._probe(gateway), interval);
    this.timers.set(gateway.id, timer);
  }

  /**
   * Остановить мониторинг и очистить данные для gateway.
   */
  stop(gatewayId) {
    const t = this.timers.get(gatewayId);
    if (t) {
      clearInterval(t);
      this.timers.delete(gatewayId);
      debug(`Gateway ${gatewayId}: monitor stopped`);
    }
    this.statuses.delete(gatewayId);
    this.windows.delete(gatewayId);
  }

  /**
   * Получить текущий статус gateway.
   */
  getStatus(gatewayId) {
    return this.statuses.get(gatewayId) || {
      status:     'unknown',
      latency:    null,
      packetLoss: null,
      lastCheck:  null,
    };
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  /**
   * Выполнить один probe (ping -c 1), записать в окно, пересчитать статус.
   */
  async _probe(gateway) {
    const { interface: iface, address, windowSeconds } = gateway.data;

    let success = false;
    let latency = null;

    try {
      const out = await Util.exec(
        `ping -c 1 -W 1 -I ${iface} ${address}`,
        { timeout: 5000, log: false }
      );

      // Packet loss: "0% packet loss" → success; "100% packet loss" → fail
      const lm = out.match(/(\d+)% packet loss/);
      const loss = lm ? parseInt(lm[1], 10) : 100;
      success = loss < 100;

      if (success) {
        // RTT: works for both -c 1 (min=avg=max) formats
        // Linux:  "rtt min/avg/max/mdev = X/AVG/X/X ms"
        // Alpine: "round-trip min/avg/max = X/AVG/X ms"
        const rm = out.match(/(?:rtt|round-trip)[^\n]+=\s*[\d.]+\/([\d.]+)\//);
        latency = rm ? Math.round(parseFloat(rm[1])) : null;
      }
    } catch {
      // timeout / interface missing / permission error → treat as packet loss
    }

    // --- Update sliding window ---
    if (!this.windows.has(gateway.id)) this.windows.set(gateway.id, []);
    const probes = this.windows.get(gateway.id);

    probes.push({ ts: Date.now(), success, latency });

    // Evict probes older than the window
    const cutoff = Date.now() - (windowSeconds * 1000);
    let evict = 0;
    while (evict < probes.length && probes[evict].ts < cutoff) evict++;
    if (evict > 0) probes.splice(0, evict);

    // --- Recalculate stats ---
    const total = probes.length;
    const lost  = probes.filter(p => !p.success).length;

    const successRate = total > 0 ? (total - lost) / total * 100 : 0;
    const packetLoss  = total > 0 ? Math.round(lost / total * 100) : null;

    // Rolling average latency (successful probes only)
    const goodProbes = probes.filter(p => p.success && p.latency !== null);
    const avgLatency = goodProbes.length > 0
      ? Math.round(goodProbes.reduce((s, p) => s + p.latency, 0) / goodProbes.length)
      : null;

    // Status — wait for MIN_PROBES before committing
    let status;
    if (total < MIN_PROBES) {
      status = 'unknown';
    } else if (successRate >= THRESHOLD_HEALTHY) {
      status = 'healthy';
    } else if (successRate >= THRESHOLD_DEGRADED) {
      status = 'degraded';
    } else {
      status = 'down';
    }

    this.statuses.set(gateway.id, {
      status,
      latency:    avgLatency,
      packetLoss,
      lastCheck:  new Date().toISOString(),
    });

    debug(`Gateway ${gateway.id}: ${status} | probes=${total} | loss=${packetLoss}% | RTT=${avgLatency}ms`);
  }
}

// Singleton
let instance = null;

module.exports = {
  getInstance() {
    if (!instance) instance = new GatewayMonitor();
    return instance;
  },
};
