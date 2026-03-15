'use strict';

const EventEmitter = require('events');
const Util     = require('./Util');
const Settings = require('./Settings');
const debug    = require('debug')('awg:GatewayMonitor');

const MIN_PROBES = 3; // need at least this many probes before committing to a status

/**
 * GatewayMonitor — singleton, запускает probe-циклы для каждого gateway.
 *
 * Логика: два независимых sliding window — ICMP и HTTP(S).
 *   ICMP:  ping -c 1 -W 1 -I <iface> <target>
 *   HTTP:  Node.js http/https request (rejectUnauthorized=false)
 *
 * Итоговый статус определяется правилом (monitorRule):
 *   icmp_only  — только ICMP (умолчание, обратная совместимость)
 *   http_only  — только HTTP
 *   all        — оба должны быть reachable (ICMP AND HTTP)
 *   any        — достаточно одного (ICMP OR HTTP)
 *
 * Window и пороги: берутся из Settings (gatewayWindowSeconds, gatewayHealthyThreshold,
 * gatewayDegradedThreshold). Per-gateway windowSeconds переопределяет глобальный.
 */
class GatewayMonitor extends EventEmitter {
  constructor() {
    super();
    // gatewayId → { status, latency, packetLoss, lastCheck, httpStatus, httpLatency, httpLastCheck }
    this.statuses    = new Map();
    // gatewayId → Array<{ ts: number, success: boolean, latency: number|null }>
    this.icmpWindows = new Map();
    this.httpWindows = new Map();
    // gatewayId → NodeJS.Timeout
    this.icmpTimers  = new Map();
    this.httpTimers  = new Map();
  }

  /**
   * Запустить мониторинг для конкретного gateway.
   * Если уже запущен — перезапустить (все окна сбрасываются).
   */
  start(gateway) {
    this.stop(gateway.id);

    if (!gateway.data.enabled || !gateway.data.monitor) {
      debug(`Gateway ${gateway.id}: monitoring disabled — skip start`);
      return;
    }

    const icmpInterval = gateway.data.monitorInterval * 1000;
    debug(`Gateway ${gateway.id}: starting ICMP monitor (interval=${gateway.data.monitorInterval}s, window=${gateway.data.windowSeconds}s)`);

    // Первый probe немедленно
    this._probeIcmp(gateway);
    const icmpTimer = setInterval(() => this._probeIcmp(gateway), icmpInterval);
    this.icmpTimers.set(gateway.id, icmpTimer);

    // HTTP monitoring — если правило требует HTTP и задан URL
    // (http.enabled игнорируется: достаточно monitorRule !== 'icmp_only' + url)
    const http = gateway.data.monitorHttp || {};
    const httpNeeded = gateway.data.monitorRule !== 'icmp_only';
    if (httpNeeded && http.url) {
      const httpInterval = (http.interval || 60) * 1000;
      debug(`Gateway ${gateway.id}: starting HTTP monitor (interval=${http.interval || 60}s, url=${http.url})`);
      this._probeHttp(gateway);
      const httpTimer = setInterval(() => this._probeHttp(gateway), httpInterval);
      this.httpTimers.set(gateway.id, httpTimer);
    }
  }

  /**
   * Остановить мониторинг и очистить все данные для gateway.
   */
  stop(gatewayId) {
    const icmpTimer = this.icmpTimers.get(gatewayId);
    if (icmpTimer) {
      clearInterval(icmpTimer);
      this.icmpTimers.delete(gatewayId);
    }
    const httpTimer = this.httpTimers.get(gatewayId);
    if (httpTimer) {
      clearInterval(httpTimer);
      this.httpTimers.delete(gatewayId);
    }
    this.statuses.delete(gatewayId);
    this.icmpWindows.delete(gatewayId);
    this.httpWindows.delete(gatewayId);
    debug(`Gateway ${gatewayId}: monitor stopped`);
  }

  /**
   * Получить текущий статус gateway.
   */
  getStatus(gatewayId) {
    return this.statuses.get(gatewayId) || {
      status:        'unknown',
      latency:       null,
      packetLoss:    null,
      lastCheck:     null,
      httpStatus:    null,
      httpLatency:   null,
      httpLastCheck: null,
      httpCode:      null,
    };
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  async _probeIcmp(gateway) {
    const { interface: iface, gatewayIP, monitorAddress } = gateway.data;
    const pingTarget = monitorAddress || gatewayIP;

    const settings = await Settings.getInstance();
    const windowSeconds     = gateway.data.windowSeconds ?? settings.data.gatewayWindowSeconds;
    const thresholdHealthy  = settings.data.gatewayHealthyThreshold;
    const thresholdDegraded = settings.data.gatewayDegradedThreshold;

    let success = false;
    let latency = null;

    try {
      const out = await Util.exec(
        `ping -c 1 -W 1 -I ${iface} ${pingTarget}`,
        { timeout: 5000, log: false }
      );

      // Packet loss: "0% packet loss" → success; "100% packet loss" → fail
      const lm = out.match(/(\d+)% packet loss/);
      const loss = lm ? parseInt(lm[1], 10) : 100;
      success = loss < 100;

      if (success) {
        // RTT: Linux "rtt min/avg/max/mdev = X/AVG/X/X ms"
        //      Alpine "round-trip min/avg/max = X/AVG/X ms"
        const rm = out.match(/(?:rtt|round-trip)[^\n]+=\s*[\d.]+\/([\d.]+)\//);
        latency = rm ? Math.round(parseFloat(rm[1])) : null;
      }
    } catch {
      // timeout / interface missing / permission error → treat as packet loss
    }

    this._addToWindow(this.icmpWindows, gateway.id, { success, latency }, windowSeconds);
    this._recomputeStatus(gateway, windowSeconds, thresholdHealthy, thresholdDegraded);
  }

  async _probeHttp(gateway) {
    const http = gateway.data.monitorHttp || {};
    const { url, expectedStatus = 200, timeout = 5 } = http;

    const settings = await Settings.getInstance();
    const windowSeconds     = gateway.data.windowSeconds ?? settings.data.gatewayWindowSeconds;
    const thresholdHealthy  = settings.data.gatewayHealthyThreshold;
    const thresholdDegraded = settings.data.gatewayDegradedThreshold;

    // HTTP-окно должно вмещать минимум MIN_PROBES проб при данном интервале.
    // Иначе короткое windowSeconds (30s по умолчанию) вытеснит все пробы
    // с HTTP-интервалом 60s → вечный 'unknown'.
    const httpInterval = http.interval || 60;
    const httpWindowSeconds = Math.max(windowSeconds, httpInterval * (MIN_PROBES + 1));

    let success = false;
    let latency = null;
    let httpCode = null;

    try {
      const urlObj = new URL(url);
      const mod = urlObj.protocol === 'https:' ? require('https') : require('http');
      const timeoutMs = timeout * 1000;
      const start = Date.now();

      await new Promise((resolve, reject) => {
        const req = mod.request({
          hostname: urlObj.hostname,
          port:     urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
          path:     (urlObj.pathname || '/') + (urlObj.search || ''),
          method:   'GET',
          headers:  { 'User-Agent': 'awg-easy-monitor/2.0', 'Connection': 'close' },
          rejectUnauthorized: false, // мониторинг — не проверяем TLS cert
        }, (res) => {
          latency  = Date.now() - start;
          httpCode = res.statusCode;
          success  = res.statusCode === expectedStatus;
          debug(`Gateway ${gateway.id}: HTTP probe → ${res.statusCode} (expected ${expectedStatus}) ${latency}ms`);
          res.resume(); // дренировать тело, иначе соединение не закрывается
          resolve();
        });

        const timer = setTimeout(() => {
          req.destroy();
          reject(new Error(`timeout after ${timeout}s`));
        }, timeoutMs);

        req.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });

        req.on('close', () => clearTimeout(timer));
        req.end();
      });
    } catch (err) {
      debug(`Gateway ${gateway.id}: HTTP probe failed: ${err.message}`);
    }

    this._addToWindow(this.httpWindows, gateway.id, { success, latency: success ? latency : null }, httpWindowSeconds);

    // Обновить httpLastCheck + httpCode в текущем статусе ДО пересчёта
    const cur = this.statuses.get(gateway.id) || {};
    this.statuses.set(gateway.id, { ...cur, httpLastCheck: new Date().toISOString(), httpCode });

    this._recomputeStatus(gateway, windowSeconds, thresholdHealthy, thresholdDegraded);
  }

  /**
   * Добавить пробу в sliding window и вытеснить устаревшие.
   */
  _addToWindow(windowsMap, gatewayId, probe, windowSeconds) {
    if (!windowsMap.has(gatewayId)) windowsMap.set(gatewayId, []);
    const probes = windowsMap.get(gatewayId);
    probes.push({ ts: Date.now(), ...probe });

    const cutoff = Date.now() - (windowSeconds * 1000);
    let evict = 0;
    while (evict < probes.length && probes[evict].ts < cutoff) evict++;
    if (evict > 0) probes.splice(0, evict);
  }

  /**
   * Вычислить статистику по window: successRate, packetLoss, avgLatency.
   */
  _calcWindowStats(windowsMap, gatewayId) {
    const probes = windowsMap.get(gatewayId) || [];
    const total  = probes.length;
    const lost   = probes.filter(p => !p.success).length;

    const successRate = total > 0 ? (total - lost) / total * 100 : 0;
    const packetLoss  = total > 0 ? Math.round(lost / total * 100) : null;

    const goodProbes = probes.filter(p => p.success && p.latency !== null);
    const avgLatency = goodProbes.length > 0
      ? Math.round(goodProbes.reduce((s, p) => s + p.latency, 0) / goodProbes.length)
      : null;

    return { total, successRate, packetLoss, avgLatency };
  }

  /**
   * Преобразовать successRate в строковый статус.
   */
  _statusFromRate(total, successRate, thresholdHealthy, thresholdDegraded) {
    if (total < MIN_PROBES)               return 'unknown';
    if (successRate >= thresholdHealthy)  return 'healthy';
    if (successRate >= thresholdDegraded) return 'degraded';
    return 'down';
  }

  /**
   * Пересчитать итоговый статус с учётом monitorRule.
   */
  _recomputeStatus(gateway, windowSeconds, thresholdHealthy, thresholdDegraded) {
    const icmp = this._calcWindowStats(this.icmpWindows, gateway.id);
    const http = this._calcWindowStats(this.httpWindows, gateway.id);

    const icmpStatus  = this._statusFromRate(icmp.total, icmp.successRate, thresholdHealthy, thresholdDegraded);
    const httpEnabled = !!(gateway.data.monitorRule !== 'icmp_only' && gateway.data.monitorHttp?.url);
    const httpStatus  = httpEnabled
      ? this._statusFromRate(http.total, http.successRate, thresholdHealthy, thresholdDegraded)
      : null;

    // Применить правило принятия решения
    const rule   = gateway.data.monitorRule || 'icmp_only';
    const isGood = (s) => s === 'healthy' || s === 'degraded';
    let combinedStatus;

    switch (rule) {
      case 'icmp_only':
        combinedStatus = icmpStatus;
        break;

      case 'http_only':
        combinedStatus = httpStatus || 'unknown';
        break;

      case 'all':
        // Оба должны быть reachable
        if (!httpStatus) { combinedStatus = icmpStatus; break; }
        if (icmpStatus === 'unknown' || httpStatus === 'unknown') { combinedStatus = 'unknown'; break; }
        if (icmpStatus === 'healthy' && httpStatus === 'healthy') combinedStatus = 'healthy';
        else if (isGood(icmpStatus) && isGood(httpStatus))        combinedStatus = 'degraded';
        else                                                        combinedStatus = 'down';
        break;

      case 'any':
        // Достаточно одного reachable
        if (!httpStatus || httpStatus === 'unknown') { combinedStatus = icmpStatus; break; }
        if (icmpStatus === 'unknown' && httpStatus === 'unknown') { combinedStatus = 'unknown'; break; }
        if (isGood(icmpStatus) || isGood(httpStatus)) {
          combinedStatus = (icmpStatus === 'healthy' || httpStatus === 'healthy') ? 'healthy' : 'degraded';
        } else {
          combinedStatus = 'down';
        }
        break;

      default:
        combinedStatus = icmpStatus;
    }

    // Сохранить httpLastCheck + httpCode из предыдущего состояния (обновляются в _probeHttp)
    const prev = this.statuses.get(gateway.id) || {};
    const prevStatus = prev.status;
    this.statuses.set(gateway.id, {
      status:        combinedStatus,
      latency:       icmp.avgLatency,
      packetLoss:    icmp.packetLoss,
      lastCheck:     new Date().toISOString(),
      httpStatus,
      httpLatency:   http.avgLatency,
      httpLastCheck: prev.httpLastCheck || null,
      httpCode:      prev.httpCode      ?? null,
    });

    debug(`Gateway ${gateway.id}: ${combinedStatus} | rule=${rule} | ICMP=${icmpStatus}(${icmp.avgLatency}ms,${icmp.packetLoss}%loss) | HTTP=${httpStatus}(${http.avgLatency}ms)`);

    // Уведомить подписчиков о смене статуса (используется FirewallManager для fallback)
    if (combinedStatus !== prevStatus) {
      this.emit('statusChange', gateway.id, combinedStatus, prevStatus);
    }
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
