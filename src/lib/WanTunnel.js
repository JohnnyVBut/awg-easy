'use strict';

const fs = require('node:fs/promises');
const path = require('path');
const debug = require('debug')('WanTunnel');

const Util = require('./Util');

const { WG_PATH } = require('../config');

/**
 * WanTunnel - управление отдельным WAN туннелем (Site-to-Site VPN)
 * 
 * Поддерживает два протокола:
 * 1. wireguard-1.0 - Vanilla WireGuard (стандартный)
 * 2. amneziawg-2.0 - AmneziaWG 2.0 (с обфускацией)
 */
module.exports = class WanTunnel {

  constructor(interfaceName, data) {
    this.interface = interfaceName;  // wg10, wg11, wg12, ...
    this.data = data;
    this.configPath = path.join(WG_PATH, `${interfaceName}.json`);
    this.wgConfPath = path.join(WG_PATH, `${interfaceName}.conf`);
  }

  /**
   * Сохранить конфигурацию туннеля (wg10.json)
   */
  async saveConfig() {
    await fs.writeFile(
      this.configPath,
      JSON.stringify(this.data, null, 2),
      { mode: 0o600 }
    );
    debug(`Config saved: ${this.configPath}`);
  }

  /**
   * Сгенерировать WireGuard конфиг (wg10.conf)
   * Формат конфига зависит от протокола
   */
  async generateWgConfig() {
    let wgConf = '';
    
    // ========================================================================
    // [Interface] секция
    // ========================================================================
    wgConf += '[Interface]\n';
    wgConf += `PrivateKey = ${this.data.privateKey}\n`;
    wgConf += `ListenPort = ${this.data.listenPort}\n`;
    
    // Добавить AWG 2.0 параметры ТОЛЬКО если protocol = "amneziawg-2.0"
    if (this.data.protocol === 'amneziawg-2.0') {
      const s = this.data.settings;
      
      wgConf += `Jc = ${s.jc}\n`;
      wgConf += `Jmin = ${s.jmin}\n`;
      wgConf += `Jmax = ${s.jmax}\n`;
      wgConf += `S1 = ${s.s1}\n`;
      wgConf += `S2 = ${s.s2}\n`;
      wgConf += `S3 = ${s.s3}\n`;
      wgConf += `S4 = ${s.s4}\n`;
      
      // H1-H4 могут быть ranges (MIN-MAX) или числами
      wgConf += `H1 = ${s.h1}\n`;
      wgConf += `H2 = ${s.h2}\n`;
      wgConf += `H3 = ${s.h3}\n`;
      wgConf += `H4 = ${s.h4}\n`;
      
      // I1-I5 параметры (опционально)
      if (s.i1) wgConf += `I1 = ${s.i1}\n`;
      if (s.i2) wgConf += `I2 = ${s.i2}\n`;
      if (s.i3) wgConf += `I3 = ${s.i3}\n`;
      if (s.i4) wgConf += `I4 = ${s.i4}\n`;
      if (s.i5) wgConf += `I5 = ${s.i5}\n`;
      
      debug(`Generated AWG 2.0 config for ${this.interface}`);
    } else {
      debug(`Generated Vanilla WG 1.0 config for ${this.interface}`);
    }
    
    // ========================================================================
    // [Peer] секция (одинаковая для обоих протоколов)
    // ========================================================================
    wgConf += '\n[Peer]\n';
    wgConf += `PublicKey = ${this.data.remotePublicKey}\n`;
    wgConf += `AllowedIPs = ${this.data.remoteSubnet}\n`;
    wgConf += `Endpoint = ${this.data.remoteEndpoint}\n`;
    wgConf += 'PersistentKeepalive = 25\n';
    
    // Сохранить конфиг
    await fs.writeFile(this.wgConfPath, wgConf, { mode: 0o600 });
    debug(`WireGuard config generated: ${this.wgConfPath}`);
  }

  /**
   * Запустить туннель
   */
  async start() {
    try {
      debug(`Starting tunnel: ${this.interface}`);
      await Util.exec(`wg-quick up ${this.interface}`);
      debug(`Tunnel started: ${this.interface}`);
    } catch (err) {
      debug(`Error starting tunnel ${this.interface}:`, err.message);
      throw new Error(`Failed to start tunnel ${this.interface}: ${err.message}`);
    }
  }

  /**
   * Остановить туннель
   */
  async stop() {
    try {
      debug(`Stopping tunnel: ${this.interface}`);
      await Util.exec(`wg-quick down ${this.interface}`);
      debug(`Tunnel stopped: ${this.interface}`);
    } catch (err) {
      // Игнорируем ошибку если туннель уже остановлен
      if (!err.message.includes('is not a WireGuard interface')) {
        debug(`Error stopping tunnel ${this.interface}:`, err.message);
      }
    }
  }

  /**
   * Перезапустить туннель
   */
  async restart() {
    await this.stop();
    await this.start();
  }

  /**
   * Включить туннель
   */
  async enable() {
    this.data.enabled = true;
    await this.saveConfig();
    await this.start();
  }

  /**
   * Отключить туннель
   */
  async disable() {
    this.data.enabled = false;
    await this.saveConfig();
    await this.stop();
  }

  /**
   * Получить статус туннеля
   */
  async getStatus() {
    try {
      const output = await Util.exec(`wg show ${this.interface}`);
      
      if (output) {
        // Парсим вывод wg show
        const lines = output.split('\n');
        const status = {
          interface: this.interface,
          running: true,
          connected: false,
        };
        
        for (const line of lines) {
          // Проверяем есть ли handshake с peer
          if (line.includes('latest handshake:')) {
            status.connected = true;
            status.latestHandshake = line.split('latest handshake:')[1].trim();
          }
          
          // Transfer данные
          if (line.includes('transfer:')) {
            const transfer = line.split('transfer:')[1].trim();
            const [received, sent] = transfer.split(',').map(s => s.trim());
            status.transfer = {
              received,
              sent,
            };
          }
        }
        
        return status;
      }
      
      return {
        interface: this.interface,
        running: false,
        connected: false,
      };
    } catch (err) {
      return {
        interface: this.interface,
        running: false,
        connected: false,
        error: err.message,
      };
    }
  }

  /**
   * Получить конфиг для удалённой стороны
   * Возвращает конфиг который нужно применить на другом конце туннеля
   */
  async getRemoteConfig() {
    let remoteConf = '';
    
    // ========================================================================
    // [Interface] секция для удалённой стороны
    // ========================================================================
    remoteConf += '[Interface]\n';
    remoteConf += '# Replace with your private key\n';
    remoteConf += 'PrivateKey = YOUR_PRIVATE_KEY_HERE\n';
    remoteConf += '# Use appropriate port\n';
    remoteConf += 'ListenPort = 51820\n';
    
    // Добавить AWG параметры если нужно
    if (this.data.protocol === 'amneziawg-2.0') {
      const s = this.data.settings;
      remoteConf += '\n# AmneziaWG 2.0 Parameters (MUST match exactly!)\n';
      remoteConf += `Jc = ${s.jc}\n`;
      remoteConf += `Jmin = ${s.jmin}\n`;
      remoteConf += `Jmax = ${s.jmax}\n`;
      remoteConf += `S1 = ${s.s1}\n`;
      remoteConf += `S2 = ${s.s2}\n`;
      remoteConf += `S3 = ${s.s3}\n`;
      remoteConf += `S4 = ${s.s4}\n`;
      remoteConf += `H1 = ${s.h1}\n`;
      remoteConf += `H2 = ${s.h2}\n`;
      remoteConf += `H3 = ${s.h3}\n`;
      remoteConf += `H4 = ${s.h4}\n`;
      
      if (s.i1) remoteConf += `I1 = ${s.i1}\n`;
      if (s.i2) remoteConf += `I2 = ${s.i2}\n`;
      if (s.i3) remoteConf += `I3 = ${s.i3}\n`;
      if (s.i4) remoteConf += `I4 = ${s.i4}\n`;
      if (s.i5) remoteConf += `I5 = ${s.i5}\n`;
    }
    
    // ========================================================================
    // [Peer] секция - наша сторона
    // ========================================================================
    remoteConf += '\n[Peer]\n';
    remoteConf += `# Our public key\n`;
    remoteConf += `PublicKey = ${this.data.publicKey}\n`;
    remoteConf += `# Our subnet\n`;
    remoteConf += `AllowedIPs = ${this.data.localSubnet}\n`;
    remoteConf += `# Our endpoint (replace YOUR_SERVER_IP with actual IP)\n`;
    remoteConf += `Endpoint = YOUR_SERVER_IP:${this.data.listenPort}\n`;
    remoteConf += 'PersistentKeepalive = 25\n';
    
    return remoteConf;
  }

  /**
   * Удалить конфигурационные файлы
   */
  async deleteConfig() {
    try {
      await fs.unlink(this.configPath);
      debug(`Deleted config: ${this.configPath}`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        debug(`Error deleting ${this.configPath}:`, err.message);
      }
    }
    
    try {
      await fs.unlink(this.wgConfPath);
      debug(`Deleted WireGuard config: ${this.wgConfPath}`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        debug(`Error deleting ${this.wgConfPath}:`, err.message);
      }
    }
  }

  /**
   * Сериализация для API
   */
  toJSON() {
    return {
      ...this.data,
      // Не отправляем приватный ключ в API
      privateKey: undefined,
    };
  }

};
