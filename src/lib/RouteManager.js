const fs = require('fs').promises;
const path = require('path');
const { createError } = require('h3');
const Util = require('./Util');
const debug = require('debug')('awg:RouteManager');

const DATA_FILE = '/etc/wireguard/data/routes.json';

/**
 * RouteManager — управление статическими маршрутами.
 * Хранит маршруты в JSON, применяет/удаляет через ip route.
 * При старте восстанавливает все enabled маршруты в ядро.
 */
class RouteManager {
  constructor() {
    this.routes = []; // { id, description, destination, gateway, dev, metric, table, enabled, createdAt }
  }

  /**
   * Инициализация: загрузить JSON, применить enabled маршруты.
   */
  async init() {
    debug('Initializing RouteManager...');
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });

    try {
      const json = await fs.readFile(DATA_FILE, 'utf8');
      this.routes = JSON.parse(json);
      debug(`Loaded ${this.routes.length} static routes`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.routes = [];
      debug('No routes file found, starting fresh');
    }

    // Применить enabled маршруты в ядро
    for (const route of this.routes) {
      if (!route.enabled) continue;
      try {
        await this._kernelAdd(route);
        debug(`Restored route ${route.destination}`);
      } catch (err) {
        // Маршрут уже может быть в ядре — не критично
        debug(`Failed to restore route ${route.destination}: ${err.message}`);
      }
    }
  }

  /**
   * Получить список routing-таблиц.
   *
   * Стратегия: обнаруживаем таблицы ЧЕРЕЗ ЯДРО (ip -j route show table all),
   * а не через /etc/iproute2/rt_tables контейнера.
   * Причина: контейнер (Alpine) имеет собственный rt_tables только со стандартными
   * таблицами; таблицы добавленные на хосте (напр. 100 vpn_kz) в нём не видны.
   * Через --network host ядро шарится, поэтому ip route show table all видит всё.
   *
   * Возвращает массив { id, name } — только таблицы с реальными маршрутами
   * + synthetic 'all' в конце.
   */
  async getRoutingTables() {
    const SKIP_IDS = new Set([0, 255]); // unspec, local
    const SKIP_NAMES = new Set(['unspec', 'local']);

    // Шаг 1: читаем rt_tables контейнера для маппинга id↔name
    // (только для известных таблиц типа main/default — хостовые там не будут)
    const RT_TABLES_FILE = '/etc/iproute2/rt_tables';
    const nameById = new Map(); // id → name
    const idByName = new Map(); // name → id
    try {
      const content = await fs.readFile(RT_TABLES_FILE, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length < 2) continue;
        const id = parseInt(parts[0], 10);
        const name = parts[1];
        nameById.set(id, name);
        idByName.set(name, id);
      }
    } catch (err) {
      debug(`Could not read rt_tables: ${err.message}`);
      // Минимальный fallback
      nameById.set(253, 'default');
      nameById.set(254, 'main');
      idByName.set('default', 253);
      idByName.set('main', 254);
    }

    // Шаг 2: обнаруживаем реально существующие таблицы из ядра.
    // ip -j route show table all возвращает маршруты из ВСЕХ таблиц.
    // Поле route.table — строка-имя (если имя есть в rt_tables контейнера)
    // или числовой ID (если имени нет — например, хостовая таблица 100).
    const found = new Map(); // key (id или name) → { id, name }
    try {
      const out = await Util.exec('ip -j route show table all', { log: false });
      const routes = JSON.parse(out || '[]');
      for (const route of routes) {
        const t = route.table;
        if (t == null) continue;

        let id, name;
        if (typeof t === 'number') {
          // ip не нашёл имя в rt_tables контейнера → вернул числовой ID
          id = t;
          name = nameById.get(id) || String(id);
        } else if (typeof t === 'string') {
          const numId = parseInt(t, 10);
          if (!isNaN(numId) && String(numId) === t) {
            // числовая строка (нет имени)
            id = numId;
            name = nameById.get(id) || t;
          } else {
            // именованная таблица ('main', 'default', 'vpn_kz', ...)
            name = t;
            id = idByName.get(t) ?? null;
          }
        } else {
          continue;
        }

        if (id !== null && SKIP_IDS.has(id)) continue;
        if (SKIP_NAMES.has(name)) continue;

        const key = id ?? name;
        if (!found.has(key)) {
          found.set(key, { id, name });
        }
      }
    } catch (err) {
      debug(`Kernel table discovery failed: ${err.message}`);
      // Fallback: берём из rt_tables контейнера
      for (const [id, name] of nameById) {
        if (SKIP_IDS.has(id) || SKIP_NAMES.has(name)) continue;
        found.set(id, { id, name });
      }
    }

    // Гарантируем main (254) даже если таблица временно пуста
    if (!found.has(254)) found.set(254, { id: 254, name: nameById.get(254) || 'main' });

    // Сортировка по id
    const tables = Array.from(found.values())
      .filter(t => t.id !== null)
      .sort((a, b) => a.id - b.id);

    // Всегда добавляем synthetic 'all' в конец
    tables.push({ id: null, name: 'all' });

    return tables;
  }

  /**
   * Получить маршруты из ядра Linux.
   * @param {string} table - 'main' | 'all' | номер таблицы
   */
  async getKernelRoutes(table = 'main') {
    const cmd = `ip -j route show table ${table}`;
    try {
      const out = await Util.exec(cmd, { log: true });
      return JSON.parse(out || '[]');
    } catch (err) {
      // ip route show table <N> падает если таблица не существует
      if (err.message && err.message.includes('ipset')) throw err;
      return [];
    }
  }

  /**
   * Тест маршрута: ip route get <ip>
   */
  async testRoute(ip) {
    if (!ip || !/^[\d.]+$/.test(ip)) {
      throw createError({ status: 400, message: 'Invalid IP address' });
    }
    const out = await Util.exec(`ip -j route get ${ip}`);
    const result = JSON.parse(out || '[]');
    return result[0] || null;
  }

  /**
   * Список managed маршрутов (из JSON).
   */
  getRoutes() {
    return this.routes;
  }

  /**
   * Добавить статический маршрут.
   */
  async addRoute(data) {
    const { description = '', destination, gateway = '', dev = '', metric = null, table = 'main' } = data;

    if (!destination) throw createError({ status: 400, message: 'Destination is required' });
    if (!gateway && !dev) throw createError({ status: 400, message: 'Gateway or interface is required' });

    const route = {
      id: this._uuid(),
      description,
      destination,
      gateway,
      dev,
      metric: metric !== '' && metric !== null ? Number(metric) : null,
      table,
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    // Применить в ядро
    await this._kernelAdd(route);

    this.routes.push(route);
    await this._save();

    debug(`Route added: ${destination}`);
    return route;
  }

  /**
   * Удалить маршрут.
   */
  async deleteRoute(id) {
    const idx = this.routes.findIndex(r => r.id === id);
    if (idx === -1) throw createError({ status: 404, message: 'Route not found' });

    const route = this.routes[idx];

    // Удалить из ядра если включён
    if (route.enabled) {
      try {
        await this._kernelDel(route);
      } catch (err) {
        debug(`kernelDel failed (route may already be gone): ${err.message}`);
      }
    }

    this.routes.splice(idx, 1);
    await this._save();
    debug(`Route deleted: ${route.destination}`);
  }

  /**
   * Включить / выключить маршрут.
   */
  async toggleRoute(id, enabled) {
    const route = this.routes.find(r => r.id === id);
    if (!route) throw createError({ status: 404, message: 'Route not found' });

    if (enabled && !route.enabled) {
      await this._kernelAdd(route);
    } else if (!enabled && route.enabled) {
      await this._kernelDel(route);
    }

    route.enabled = enabled;
    await this._save();
    return route;
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  async _kernelAdd(route) {
    let cmd = `ip route add ${route.destination}`;
    if (route.gateway) cmd += ` via ${route.gateway}`;
    if (route.dev)     cmd += ` dev ${route.dev}`;
    if (route.metric)  cmd += ` metric ${route.metric}`;
    if (route.table && route.table !== 'main') cmd += ` table ${route.table}`;
    await Util.exec(cmd);
  }

  async _kernelDel(route) {
    let cmd = `ip route del ${route.destination}`;
    if (route.gateway) cmd += ` via ${route.gateway}`;
    if (route.dev)     cmd += ` dev ${route.dev}`;
    if (route.table && route.table !== 'main') cmd += ` table ${route.table}`;
    await Util.exec(cmd);
  }

  async _save() {
    await fs.writeFile(DATA_FILE, JSON.stringify(this.routes, null, 2));
  }

  _uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
}

// Singleton
let instance = null;
let instanceReady = null;

module.exports = {
  getInstance: async () => {
    if (!instance) {
      instance = new RouteManager();
      instanceReady = instance.init();
    }
    await instanceReady;
    return instance;
  },
};
