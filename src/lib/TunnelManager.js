'use strict';

const fs = require('node:fs/promises');
const path = require('path');
const debug = require('debug')('TunnelManager');

const WanTunnel = require('./WanTunnel');
const Util = require('./Util');

const { WG_PATH } = require('../config');

/**
 * TunnelManager - управление WAN туннелями (Site-to-Site VPN)
 * 
 * Поддерживаемые протоколы:
 * - wireguard-1.0: Vanilla WireGuard (стандартный протокол)
 * - amneziawg-2.0: AmneziaWG 2.0 (с обфускацией)
 * 
 * Структура файлов:
 * /etc/wireguard/tunnels.json - мета-конфигурация всех туннелей
 * /etc/wireguard/wg10.json    - конфигурация туннеля wg10
 * /etc/wireguard/wg10.conf    - WireGuard конфиг wg10
 */
module.exports = class TunnelManager {

  constructor() {
    this.wanTunnels = new Map();
    this.tunnelsConfigPath = path.join(WG_PATH, 'tunnels.json');
  }

  /**
   * Инициализация: загрузка всех туннелей из tunnels.json
   */
  async init() {
    debug('Initializing TunnelManager...');
    
    try {
      const data = await fs.readFile(this.tunnelsConfigPath, 'utf8');
      const config = JSON.parse(data);
      
      if (config.wanTunnels) {
        for (const [interfaceName, tunnelData] of Object.entries(config.wanTunnels)) {
          const tunnel = new WanTunnel(interfaceName, tunnelData);
          this.wanTunnels.set(interfaceName, tunnel);
          debug(`Loaded WAN tunnel: ${interfaceName} (${tunnelData.protocol})`);
        }
      }
      
      debug(`TunnelManager initialized. ${this.wanTunnels.size} WAN tunnels loaded.`);
    } catch (err) {
      if (err.code === 'ENOENT') {
        debug('tunnels.json not found, creating new configuration');
        await this._saveTunnelsConfig({ wanTunnels: {} });
      } else {
        throw err;
      }
    }
  }

  /**
   * Сохранение tunnels.json
   */
  async _saveTunnelsConfig(config) {
    await fs.writeFile(
      this.tunnelsConfigPath,
      JSON.stringify(config, null, 2),
      { mode: 0o600 }
    );
    debug('tunnels.json saved');
  }

  /**
   * Получить следующий доступный номер интерфейса (wg10, wg11, wg12, ...)
   */
  _getNextInterfaceName() {
    // WAN туннели начинаются с wg10
    let interfaceNumber = 10;
    
    while (this.wanTunnels.has(`wg${interfaceNumber}`)) {
      interfaceNumber++;
    }
    
    return `wg${interfaceNumber}`;
  }

  /**
   * Получить следующий доступный порт (51830, 51831, ...)
   */
  _getNextListenPort() {
    // WAN туннели используют порты начиная с 51830
    let port = 51830;
    const usedPorts = new Set();
    
    for (const tunnel of this.wanTunnels.values()) {
      usedPorts.add(tunnel.data.listenPort);
    }
    
    while (usedPorts.has(port)) {
      port++;
    }
    
    return port;
  }

  /**
   * Создать новый WAN туннель
   * 
   * @param {Object} data - данные туннеля
   * @param {string} data.name - название туннеля
   * @param {string} data.protocol - 'wireguard-1.0' или 'amneziawg-2.0'
   * @param {string} data.localSubnet - локальная подсеть (192.168.1.0/24)
   * @param {string} data.remoteSubnet - удалённая подсеть (192.168.2.0/24)
   * @param {string} data.remoteEndpoint - удалённый endpoint (vpn.example.com:51820)
   * @param {string} data.remotePublicKey - публичный ключ удалённой стороны
   * @param {number} [data.listenPort] - порт прослушивания (авто если не указан)
   * @param {Object} [data.settings] - AWG 2.0 параметры (только для amneziawg-2.0)
   */
  async createWanTunnel(data) {
    debug(`Creating WAN tunnel: ${data.name} (${data.protocol})`);
    
    // Валидация протокола
    if (!['wireguard-1.0', 'amneziawg-2.0'].includes(data.protocol)) {
      throw new Error(`Invalid protocol: ${data.protocol}. Must be 'wireguard-1.0' or 'amneziawg-2.0'`);
    }
    
    // Валидация обязательных полей
    if (!data.name) throw new Error('Tunnel name is required');
    if (!data.localSubnet) throw new Error('Local subnet is required');
    if (!data.remoteSubnet) throw new Error('Remote subnet is required');
    if (!data.remoteEndpoint) throw new Error('Remote endpoint is required');
    if (!data.remotePublicKey) throw new Error('Remote public key is required');
    
    // Генерация ключей
    const privateKey = await Util.exec('wg genkey');
    const publicKey = await Util.exec(`echo ${privateKey} | wg pubkey`, {
      log: 'echo ***hidden*** | wg pubkey',
    });
    
    // Получение интерфейса и порта
    const interfaceName = this._getNextInterfaceName();
    const listenPort = data.listenPort || this._getNextListenPort();
    
    // Создание конфигурации туннеля
    const tunnelData = {
      id: interfaceName,
      name: data.name,
      type: 'wan',
      protocol: data.protocol,
      interface: interfaceName,
      localSubnet: data.localSubnet,
      remoteSubnet: data.remoteSubnet,
      remoteEndpoint: data.remoteEndpoint,
      remotePublicKey: data.remotePublicKey,
      listenPort,
      privateKey,
      publicKey,
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    
    // Добавить AWG параметры если протокол = amneziawg-2.0
    if (data.protocol === 'amneziawg-2.0') {
      if (!data.settings) {
        throw new Error('AWG 2.0 settings are required for amneziawg-2.0 protocol');
      }
      tunnelData.settings = data.settings;
    }
    
    // Создать объект туннеля
    const tunnel = new WanTunnel(interfaceName, tunnelData);
    
    // Сохранить конфигурацию туннеля
    await tunnel.saveConfig();
    
    // Генерировать WireGuard конфиг
    await tunnel.generateWgConfig();
    
    // Добавить в Map
    this.wanTunnels.set(interfaceName, tunnel);
    
    // Обновить tunnels.json
    await this._updateTunnelsJson();
    
    // НЕ запускаем туннель автоматически!
    // WAN туннели должны запускаться вручную через enable() или restart()
    // потому что требуют настройки удалённой стороны
    
    debug(`WAN tunnel created: ${interfaceName} (not started)`);
    
    return tunnel.toJSON();
  }

  /**
   * Обновить tunnels.json
   */
  async _updateTunnelsJson() {
    const config = {
      wanTunnels: {},
    };
    
    for (const [interfaceName, tunnel] of this.wanTunnels) {
      config.wanTunnels[interfaceName] = tunnel.data;
    }
    
    await this._saveTunnelsConfig(config);
  }

  /**
   * Получить все WAN туннели
   */
  async getWanTunnels() {
    const tunnels = [];
    
    for (const tunnel of this.wanTunnels.values()) {
      const status = await tunnel.getStatus();
      tunnels.push({
        ...tunnel.toJSON(),
        status,
      });
    }
    
    return tunnels;
  }

  /**
   * Получить конкретный туннель
   */
  getWanTunnel(interfaceName) {
    const tunnel = this.wanTunnels.get(interfaceName);
    if (!tunnel) {
      throw new Error(`WAN tunnel not found: ${interfaceName}`);
    }
    return tunnel;
  }

  /**
   * Удалить WAN туннель
   */
  async deleteWanTunnel(interfaceName) {
    debug(`Deleting WAN tunnel: ${interfaceName}`);
    
    const tunnel = this.getWanTunnel(interfaceName);
    
    // Остановить туннель
    await tunnel.stop();
    
    // Удалить конфигурационные файлы
    await tunnel.deleteConfig();
    
    // Удалить из Map
    this.wanTunnels.delete(interfaceName);
    
    // Обновить tunnels.json
    await this._updateTunnelsJson();
    
    debug(`WAN tunnel deleted: ${interfaceName}`);
  }

  /**
   * Включить туннель
   */
  async enableWanTunnel(interfaceName) {
    const tunnel = this.getWanTunnel(interfaceName);
    await tunnel.enable();
    await this._updateTunnelsJson();
  }

  /**
   * Отключить туннель
   */
  async disableWanTunnel(interfaceName) {
    const tunnel = this.getWanTunnel(interfaceName);
    await tunnel.disable();
    await this._updateTunnelsJson();
  }

  /**
   * Перезапустить туннель
   */
  async restartWanTunnel(interfaceName) {
    const tunnel = this.getWanTunnel(interfaceName);
    await tunnel.restart();
  }

};
