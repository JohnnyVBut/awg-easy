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
   * Стратегия (без ip -j, который зависает на некоторых ядрах):
   * 1. Читаем /etc/iproute2/rt_tables контейнера → базовый маппинг id↔name
   * 2. Запускаем `ip rule show` (text, без -j) → находим дополнительные таблицы
   *    через паттерн "lookup <table>" в строках политики маршрутизации.
   *    Это позволяет обнаружить хостовые таблицы (напр. 100/vpn_kz) через --network host.
   *
   * Возвращает массив { id, name } + synthetic 'all' в конце.
   */
  async getRoutingTables() {
    const SKIP_IDS = new Set([0, 255]); // unspec, local
    const SKIP_NAMES = new Set(['unspec', 'local']);

    // Шаг 1: читаем rt_tables контейнера для базового маппинга id↔name
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
      nameById.set(253, 'default');
      nameById.set(254, 'main');
      idByName.set('default', 253);
      idByName.set('main', 254);
    }

    // Шаг 2: обнаруживаем таблицы через `ip rule show` (text, без -j).
    // Пример строк:
    //   0:      lookup local
    //   32766:  lookup main
    //   10000:  from all lookup 100
    const found = new Map(); // id → { id, name }
    try {
      const out = await Util.exec('ip rule show', { log: false, timeout: 5000 });
      for (const line of (out || '').split('\n')) {
        const m = line.match(/\blookup\s+(\S+)/);
        if (!m) continue;
        const token = m[1];
        const numId = parseInt(token, 10);

        let id, name;
        if (!isNaN(numId) && String(numId) === token) {
          // числовой ID → ищем имя в rt_tables
          id = numId;
          name = nameById.get(id) || String(id);
        } else {
          // именованная таблица ('main', 'default', 'vpn_kz', ...)
          name = token;
          id = idByName.get(token) ?? null;
        }

        if (id === null) continue;
        if (SKIP_IDS.has(id) || SKIP_NAMES.has(name)) continue;
        if (!found.has(id)) found.set(id, { id, name });
      }
    } catch (err) {
      debug(`ip rule show failed: ${err.message}`);
      // Fallback: только то что есть в rt_tables контейнера
      for (const [id, name] of nameById) {
        if (SKIP_IDS.has(id) || SKIP_NAMES.has(name)) continue;
        found.set(id, { id, name });
      }
    }

    // Гарантируем main (254)
    if (!found.has(254)) found.set(254, { id: 254, name: nameById.get(254) || 'main' });

    // Сортировка по id
    const tables = Array.from(found.values()).sort((a, b) => a.id - b.id);

    // Всегда добавляем synthetic 'all' в конец
    tables.push({ id: null, name: 'all' });

    return tables;
  }

  /**
   * Получить маршруты из ядра Linux.
   * Использует текстовый вывод ip route show (без -j) — работает на любом ядре.
   * Флаг -j (JSON) зависает на некоторых конфигурациях ядра Linux и не используется.
   * @param {string} table - 'main' | 'all' | номер таблицы
   */
  async getKernelRoutes(table = 'main') {
    const cmd = `ip route show table ${table}`;
    try {
      const out = await Util.exec(cmd, { log: true, timeout: 5000 });
      return RouteManager._parseTextRoutes(out || '');
    } catch (err) {
      const msg = err.message || '';
      // Таблица не существует — нормальная ситуация
      if (msg.includes('Invalid argument') || msg.includes('No such process') ||
          msg.includes('does not exist') || msg.includes('RTNETLINK')) {
        return [];
      }
      debug(`getKernelRoutes failed for table "${table}": ${msg}`);
      throw createError({ status: 500, message: `ip route error: ${msg}` });
    }
  }

  /**
   * Парсинг текстового вывода `ip route show`.
   * Формат строки:
   *   <dst> [via <gw>] dev <dev> proto <proto> [scope <scope>] [src <src>] [metric <n>]
   * Примеры:
   *   default via 62.113.116.1 dev ens3 proto static onlink
   *   10.8.0.0/24 dev wg0 proto kernel scope link src 10.8.0.1
   */
  static _parseTextRoutes(text) {
    const routes = [];
    for (const rawLine of text.split('\n')) {
      // Строки с отступом — продолжение предыдущего маршрута (nexthops), пропускаем
      if (rawLine.startsWith('\t') || rawLine.startsWith('  ')) continue;
      const line = rawLine.trim();
      if (!line) continue;

      const tokens = line.split(/\s+/);
      if (tokens.length < 2) continue;

      const route = { dst: tokens[0] };

      // Извлекаем пары ключ-значение
      for (let i = 1; i < tokens.length; i++) {
        const key = tokens[i];
        const val = tokens[i + 1];
        if (!val) continue;
        if (key === 'via')     { route.gateway  = val; i++; }
        else if (key === 'dev')     { route.dev      = val; i++; }
        else if (key === 'proto')   { route.protocol = val; i++; }
        else if (key === 'metric')  { route.metric   = Number(val); i++; }
        else if (key === 'scope')   { route.scope    = val; i++; }
        else if (key === 'src')     { route.prefsrc  = val; i++; }
        else if (key === 'table')   { route.table    = val; i++; }
      }

      routes.push(route);
    }
    return routes;
  }

  /**
   * Тест маршрута: ip route get <ip>
   * Парсит текстовый вывод (без -j).
   * Пример: "10.8.0.5 dev wg0 src 10.8.0.1 uid 0"
   */
  async testRoute(ip) {
    if (!ip || !/^[\d.a-fA-F:]+$/.test(ip)) {
      throw createError({ status: 400, message: 'Invalid IP address' });
    }
    const out = await Util.exec(`ip route get ${ip}`, { timeout: 5000 });
    if (!out) return null;
    // ip route get возвращает одну строку (или несколько, если есть nexthop)
    // Берём первую значимую строку
    const line = out.split('\n').find(l => l.trim()) || '';
    const tokens = line.trim().split(/\s+/);
    if (!tokens.length) return null;

    const result = { dst: tokens[0] };
    for (let i = 1; i < tokens.length; i++) {
      const k = tokens[i], v = tokens[i + 1];
      if (!v) continue;
      if (k === 'via')   { result.gateway = v; i++; }
      if (k === 'dev')   { result.dev = v; i++; }
      if (k === 'src')   { result.prefsrc = v; i++; }
      if (k === 'proto') { result.protocol = v; i++; }
      if (k === 'table') { result.table = v; i++; }
    }
    return result;
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
      try {
        await this._kernelDel(route);
      } catch (err) {
        // Маршрут мог быть удалён из ядра внешне (например, wg-quick down) — не критично
        debug(`_kernelDel in toggle failed (route may already be gone): ${err.message}`);
      }
    }

    route.enabled = enabled;
    await this._save();
    return route;
  }

  /**
   * Переприменить маршруты, привязанные к указанному сетевому интерфейсу.
   *
   * Вызывается после start/restart WireGuard-интерфейса: wg-quick down→up цикл
   * удаляет все кастомные маршруты через этот интерфейс из таблицы ядра.
   * После повторного подъёма интерфейса маршруты нужно восстановить.
   *
   * @param {string} devName - Имя интерфейса ('wg10', 'wg11', ...)
   */
  async reapplyForDevice(devName) {
    const devRoutes = this.routes.filter(r => r.enabled && r.dev === devName);
    if (!devRoutes.length) return;

    debug(`Reapplying ${devRoutes.length} route(s) for device ${devName}`);
    for (const route of devRoutes) {
      try {
        await this._kernelAdd(route);
        debug(`Reapplied route ${route.destination} via ${devName}`);
      } catch (err) {
        // "File exists" = маршрут уже в ядре — нормально
        debug(`Reapply route ${route.destination} via ${devName}: ${err.message}`);
      }
    }
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
