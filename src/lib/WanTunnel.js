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
    
    // Добавить туннельный Address если указан
    if (this.data.localTunnelAddress) {
      wgConf += `Address = ${this.data.localTunnelAddress}\n`;
    }
    
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
    // Генерируем новую пару ключей для удалённой стороны
    const remotePrivateKey = await Util.exec('wg genkey');
    const remotePublicKey = await Util.exec(`echo ${remotePrivateKey} | wg pubkey`, {
      log: 'echo ***hidden*** | wg pubkey',
    });
    
    let remoteConf = '';
    
    // ========================================================================
    // Инструкция вверху
    // ========================================================================
    remoteConf += '# ═══════════════════════════════════════════════════════════════\n';
    remoteConf += '# Remote Site Configuration - Apply this on the OTHER side\n';
    remoteConf += `# Tunnel: ${this.data.name}\n`;
    remoteConf += `# Protocol: ${this.data.protocol === 'amneziawg-2.0' ? 'AmneziaWG 2.0' : 'WireGuard 1.0'}\n`;
    remoteConf += '# ═══════════════════════════════════════════════════════════════\n';
    remoteConf += '\n';
    
    // ========================================================================
    // [Interface] секция для удалённой стороны
    // ========================================================================
    remoteConf += '[Interface]\n';
    remoteConf += `# Private key for remote side (GENERATED)\n`;
    remoteConf += `PrivateKey = ${remotePrivateKey}\n`;
    remoteConf += '\n';
    remoteConf += '# Listen port (choose any free UDP port)\n';
    remoteConf += 'ListenPort = 51820\n';
    remoteConf += '\n';
    
    // Добавить туннельный Address если указан
    if (this.data.remoteTunnelAddress) {
      remoteConf += `# Tunnel address for remote side\n`;
      remoteConf += `Address = ${this.data.remoteTunnelAddress}\n`;
      remoteConf += '\n';
    }
    
    // Добавить AWG параметры если нужно
    if (this.data.protocol === 'amneziawg-2.0') {
      const s = this.data.settings;
      remoteConf += '\n# ═══════════════════════════════════════════════════════════════\n';
      remoteConf += '# AmneziaWG 2.0 Parameters (MUST match EXACTLY on both sides!)\n';
      remoteConf += '# ═══════════════════════════════════════════════════════════════\n';
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
    // [Peer] секция - настройка для подключения к НАШЕЙ стороне
    // ========================================================================
    remoteConf += '\n[Peer]\n';
    remoteConf += `# Public key of THIS server\n`;
    remoteConf += `PublicKey = ${this.data.publicKey}\n`;
    remoteConf += '\n';
    remoteConf += `# Routes to THIS server's subnet\n`;
    remoteConf += `AllowedIPs = ${this.data.localSubnet}\n`;
    remoteConf += '\n';
    
    // Попытка определить публичный IP сервера
    let serverEndpoint = 'YOUR_SERVER_PUBLIC_IP';
    try {
      // Пробуем получить из переменной окружения WG_HOST
      const WG_HOST = process.env.WG_HOST;
      if (WG_HOST && WG_HOST !== '0.0.0.0') {
        serverEndpoint = WG_HOST;
      }
    } catch (e) {
      // Игнорируем ошибку
    }
    
    remoteConf += `# Endpoint of THIS server\n`;
    remoteConf += `# Replace ${serverEndpoint} with your actual public IP if needed\n`;
    remoteConf += `Endpoint = ${serverEndpoint}:${this.data.listenPort}\n`;
    remoteConf += '\n';
    remoteConf += 'PersistentKeepalive = 25\n';
    
    // ========================================================================
    // Инструкция внизу
    // ========================================================================
    remoteConf += '\n';
    remoteConf += '# ═══════════════════════════════════════════════════════════════\n';
    remoteConf += '# IMPORTANT: Copy the public key below and add it to THIS server!\n';
    remoteConf += '# ═══════════════════════════════════════════════════════════════\n';
    remoteConf += `# Remote Public Key: ${remotePublicKey}\n`;
    remoteConf += '#\n';
    remoteConf += '# How to apply on remote side:\n';
    if (this.data.protocol === 'amneziawg-2.0') {
      remoteConf += '#   1. Save this file as /etc/amnezia/amneziawg/wg0.conf\n';
      remoteConf += '#   2. Run: awg-quick up wg0\n';
    } else {
      remoteConf += '#   1. Save this file as /etc/wireguard/wg0.conf\n';
      remoteConf += '#   2. Run: wg-quick up wg0\n';
    }
    remoteConf += `#   3. Update THIS server with remote public key: ${remotePublicKey}\n`;
    remoteConf += '# ═══════════════════════════════════════════════════════════════\n';
    
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
