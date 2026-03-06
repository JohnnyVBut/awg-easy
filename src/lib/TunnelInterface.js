const fs = require('fs').promises;
const path = require('path');
const Peer = require('./Peer');
const Util = require('./Util');
const debug = require('debug')('awg:TunnelInterface');

/**
 * TunnelInterface - туннельный интерфейс (wg10, wg11, etc.)
 * Один интерфейс может иметь множество peers (hub-and-spoke модель)
 */
class TunnelInterface {
  /**
   * @param {string} id - имя интерфейса (wg10, wg11, etc.)
   * @param {Object} data - данные интерфейса
   */
  constructor(id, data) {
    this.id = id;
    this.data = {
      name: data.name,                    // Friendly name
      protocol: data.protocol || 'wireguard-1.0',
      privateKey: data.privateKey,
      publicKey: data.publicKey,
      listenPort: data.listenPort,
      address: data.address || '',        // Tunnel address (например 10.100.0.1/24)
      settings: data.settings || {},      // AWG параметры
      disableRoutes: data.disableRoutes || false, // Table = off (для кастомного роутинга)
      enabled: data.enabled !== false,
      createdAt: data.createdAt || new Date().toISOString(),
      peerIds: data.peerIds || [],        // Массив ID peers
    };
    
    this.peers = new Map(); // peerId -> Peer instance

    // Serialises reload() calls so they never run concurrently on the same interface.
    // Concurrent awg/wg syncconf on the same device causes a kernel deadlock.
    this._reloadMutex = Promise.resolve();

    // Пути
    this.dataDir = '/etc/wireguard/data';
    this.interfaceFile = `${this.dataDir}/interfaces/${this.id}.json`;
    this.peersDir = `${this.dataDir}/peers/${this.id}`;
    this.confFile = `/etc/wireguard/${this.id}.conf`;
    
    debug(`TunnelInterface created: ${this.id} (${this.data.name})`);
  }

  /**
   * Сохранить данные интерфейса
   */
  async save() {
    await fs.mkdir(path.dirname(this.interfaceFile), { recursive: true });
    await fs.mkdir(this.peersDir, { recursive: true });
    
    const json = JSON.stringify(this.data, null, 2);
    await fs.writeFile(this.interfaceFile, json);
    
    debug(`Interface ${this.id} saved`);
  }

  /**
   * Загрузить интерфейс из файла
   */
  static async load(id) {
    const interfaceFile = `/etc/wireguard/data/interfaces/${id}.json`;
    const json = await fs.readFile(interfaceFile, 'utf8');
    const data = JSON.parse(json);
    
    const iface = new TunnelInterface(id, data);
    await iface.loadPeers();
    
    debug(`Interface ${id} loaded`);
    return iface;
  }

  /**
   * Загрузить все peers для этого интерфейса
   */
  async loadPeers() {
    try {
      const files = await fs.readdir(this.peersDir);
      
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        
        const peerFile = path.join(this.peersDir, file);
        const json = await fs.readFile(peerFile, 'utf8');
        const peerData = JSON.parse(json);
        
        const peer = new Peer(peerData);
        this.peers.set(peer.id, peer);
      }
      
      debug(`Loaded ${this.peers.size} peers for ${this.id}`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      // Директория не существует - нет peers
    }
  }

  /**
   * Добавить peer
   * Если peerData.generateKeys === true — сервер генерирует ключи автоматически.
   */
  async addPeer(peerData) {
    // Auto-allocate IP if requested
    if (peerData.autoAllocateIP) {
      peerData.allowedIPs = this._getNextAvailableIP();
      delete peerData.autoAllocateIP;
    }

    // Генерация ключей если запрошена
    if (peerData.generateKeys) {
      const privateKey = (await Util.exec('wg genkey')).trim();
      const publicKey = (await Util.exec(`echo ${privateKey} | wg pubkey`, {
        log: 'echo ***hidden*** | wg pubkey',
      })).trim();
      const presharedKey = (await Util.exec('wg genpsk')).trim();

      peerData = {
        ...peerData,
        privateKey,
        publicKey,
        presharedKey,
        generateKeys: undefined, // убрать флаг
      };
    }

    // Валидация
    const peer = new Peer({
      ...peerData,
      interfaceId: this.id,
    });
    
    const errors = peer.validate();
    if (errors.length > 0) {
      throw new Error(`Peer validation failed: ${errors.join(', ')}`);
    }
    
    // Сохранить peer
    const peerFile = path.join(this.peersDir, `${peer.id}.json`);
    await fs.mkdir(this.peersDir, { recursive: true });
    await fs.writeFile(peerFile, JSON.stringify(peer.toJSON(), null, 2));
    
    // Добавить в Map
    this.peers.set(peer.id, peer);
    
    // Обновить список peer IDs
    this.data.peerIds.push(peer.id);
    await this.save();
    
    // Регенерировать конфиг на диске
    await this.regenerateConfig();

    // Применить в ядро атомарно (без syncconf — чтобы не трогать H1-H4)
    if (this.data.enabled) {
      await this._kernelSetPeer(peer);
    }

    debug(`Peer ${peer.id} added to ${this.id}`);
    return peer;
  }

  /**
   * Обновить peer.
   * Reload выполняется ТОЛЬКО если изменились поля, влияющие на WireGuard конфиг.
   * Metadata-поля (name, expireDate, oneTimeLink, updatedAt) не требуют reload —
   * это предотвращает лишние системные вызовы и снижает вероятность kernel hang.
   */
  async updatePeer(peerId, updates) {
    const peer = this.peers.get(peerId);
    if (!peer) {
      throw new Error(`Peer ${peerId} not found`);
    }

    // Обновить данные
    Object.assign(peer, updates);

    // Валидация
    const errors = peer.validate();
    if (errors.length > 0) {
      throw new Error(`Peer validation failed: ${errors.join(', ')}`);
    }

    // Сохранить на диск
    const peerFile = path.join(this.peersDir, `${peer.id}.json`);
    await fs.writeFile(peerFile, JSON.stringify(peer.toJSON(), null, 2));

    // Поля, которые реально меняют WireGuard конфиг (попадают в [Peer] секцию)
    const WG_CONFIG_FIELDS = ['enabled', 'publicKey', 'presharedKey', 'allowedIPs', 'endpoint', 'persistentKeepalive'];
    const needsWgReload = WG_CONFIG_FIELDS.some(field => field in updates);

    if (needsWgReload) {
      // Регенерировать wg-quick конфиг файл на диске
      await this.regenerateConfig();
      // Применить изменения в ядро атомарно (один peer — без syncconf)
      if (this.data.enabled) {
        if (peer.enabled) {
          await this._kernelSetPeer(peer);
        } else {
          await this._kernelRemovePeer(peer.id, peer.publicKey);
        }
      }
    }

    debug(`Peer ${peerId} updated (wgReload=${needsWgReload})`);
    return peer;
  }

  /**
   * Удалить peer
   */
  async removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) {
      throw new Error(`Peer ${peerId} not found`);
    }

    // Сохраняем publicKey до удаления из Map (нужен для kernel remove)
    const { publicKey } = peer;

    // Удалить файл
    const peerFile = path.join(this.peersDir, `${peer.id}.json`);
    await fs.unlink(peerFile);

    // Удалить из Map
    this.peers.delete(peerId);

    // Обновить список
    this.data.peerIds = this.data.peerIds.filter(id => id !== peerId);
    await this.save();

    // Регенерировать конфиг на диске
    await this.regenerateConfig();

    // Удалить из ядра атомарно
    if (this.data.enabled) {
      await this._kernelRemovePeer(peerId, publicKey);
    }

    debug(`Peer ${peerId} removed`);
  }

  /**
   * Получить peer по ID
   */
  getPeer(peerId) {
    return this.peers.get(peerId);
  }

  /**
   * Получить все peers
   */
  getAllPeers() {
    return Array.from(this.peers.values());
  }

  /**
   * Сгенерировать WireGuard конфиг
   */
  /**
   * Compute network address from a CIDR string.
   * e.g. "10.100.0.1/24" → "10.100.0.0/24"
   */
  _cidrToSubnet(cidr) {
    const [ip, prefix] = cidr.split('/');
    const prefixLen = parseInt(prefix, 10);
    const parts = ip.split('.').map(Number);
    const ipInt = (parts[0] << 24 | parts[1] << 16 | parts[2] << 8 | parts[3]) >>> 0;
    const maskInt = prefixLen === 0 ? 0 : (0xffffffff << (32 - prefixLen)) >>> 0;
    const subnetInt = (ipInt & maskInt) >>> 0;
    const s = [
      (subnetInt >>> 24) & 0xff,
      (subnetInt >>> 16) & 0xff,
      (subnetInt >>> 8) & 0xff,
      subnetInt & 0xff,
    ];
    return `${s.join('.')}/${prefix}`;
  }

  /**
   * Find next available IP in the interface subnet.
   * Scans from network+1 to broadcast-1, skipping the interface IP and all used peer IPs.
   * Returns IP in "X.X.X.X/32" format.
   */
  _getNextAvailableIP() {
    if (!this.data.address) {
      throw new Error('Interface has no address configured');
    }

    const [ifaceIp, prefix] = this.data.address.split('/');
    const prefixLen = parseInt(prefix, 10);

    const ipToInt = (ip) => {
      const p = ip.split('.').map(Number);
      return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
    };

    const intToIp = (int) => {
      return `${(int >>> 24) & 0xff}.${(int >>> 16) & 0xff}.${(int >>> 8) & 0xff}.${int & 0xff}`;
    };

    const ifaceInt = ipToInt(ifaceIp);
    const maskInt = prefixLen === 0 ? 0 : (0xffffffff << (32 - prefixLen)) >>> 0;
    const networkInt = (ifaceInt & maskInt) >>> 0;
    const broadcastInt = (networkInt | ((~maskInt) >>> 0)) >>> 0;

    // Collect all used IPs (interface + all peers)
    const usedIPs = new Set();
    usedIPs.add(ifaceInt);

    for (const peer of this.peers.values()) {
      if (peer.allowedIPs) {
        const peerIpStr = peer.allowedIPs.split(',')[0].trim().split('/')[0];
        usedIPs.add(ipToInt(peerIpStr));
      }
    }

    // Scan from network+1 to broadcast-1
    for (let i = networkInt + 1; i < broadcastInt; i++) {
      if (!usedIPs.has(i >>> 0)) {
        return `${intToIp(i)}/32`;
      }
    }

    throw new Error('No available IP addresses in subnet');
  }

  generateWgConfig() {
    let config = '';

    // ======== [Interface] ========
    config += '[Interface]\n';
    config += `# ${this.data.name}\n`;
    config += `PrivateKey = ${this.data.privateKey}\n`;
    config += `ListenPort = ${this.data.listenPort}\n`;

    // Disable Routes: Table = off prevents wg-quick from adding routes to the routing table.
    // Useful for custom routing / PBR setups.
    if (this.data.disableRoutes) {
      config += `Table = off\n`;
    }

    if (this.data.address) {
      config += `Address = ${this.data.address}\n`;
      // NAT: masquerade VPN client traffic so it can reach the internet.
      // PostUp/PostDown are executed by wg-quick / awg-quick on interface up/down.
      const subnet = this._cidrToSubnet(this.data.address);
      config += `PostUp = iptables-nft -I FORWARD -i ${this.id} -j ACCEPT; iptables-nft -I FORWARD -o ${this.id} -j ACCEPT; iptables-nft -t nat -A POSTROUTING -s ${subnet} -j MASQUERADE\n`;
      config += `PostDown = iptables-nft -D FORWARD -i ${this.id} -j ACCEPT 2>/dev/null || true; iptables-nft -D FORWARD -o ${this.id} -j ACCEPT 2>/dev/null || true; iptables-nft -t nat -D POSTROUTING -s ${subnet} -j MASQUERADE 2>/dev/null || true\n`;
    }

    // AWG параметры
    if (this.data.protocol === 'amneziawg-2.0') {
      const s = this.data.settings;
      config += '\n# AmneziaWG 2.0 Parameters\n';
      config += `Jc = ${s.jc}\n`;
      config += `Jmin = ${s.jmin}\n`;
      config += `Jmax = ${s.jmax}\n`;
      config += `S1 = ${s.s1}\n`;
      config += `S2 = ${s.s2}\n`;
      config += `S3 = ${s.s3}\n`;
      config += `S4 = ${s.s4}\n`;
      config += `H1 = ${s.h1}\n`;
      config += `H2 = ${s.h2}\n`;
      config += `H3 = ${s.h3}\n`;
      config += `H4 = ${s.h4}\n`;
      
      if (s.i1) config += `I1 = ${s.i1}\n`;
      if (s.i2) config += `I2 = ${s.i2}\n`;
      if (s.i3) config += `I3 = ${s.i3}\n`;
      if (s.i4) config += `I4 = ${s.i4}\n`;
      if (s.i5) config += `I5 = ${s.i5}\n`;
    }
    
    // ======== [Peer] секции ========
    for (const peer of this.peers.values()) {
      config += peer.toWgConfig();
    }
    
    return config;
  }

  /**
   * Регенерировать WireGuard конфиг
   */
  async regenerateConfig() {
    const config = this.generateWgConfig();
    await fs.writeFile(this.confFile, config, { mode: 0o600 });
    debug(`Config regenerated: ${this.confFile}`);
  }

  /**
   * Возвращает правильную утилиту для управления интерфейсом:
   * - amneziawg-2.0 → awg-quick / awg (требует amneziawg.ko на хосте)
   * - wireguard-1.0  → wg-quick  / wg
   */
  get _quickBin() {
    return this.data.protocol === 'amneziawg-2.0' ? 'awg-quick' : 'wg-quick';
  }

  get _syncBin() {
    return this.data.protocol === 'amneziawg-2.0' ? 'awg' : 'wg';
  }

  /**
   * Запустить интерфейс.
   * Всегда регенерирует конфиг перед подъёмом — это гарантирует что
   * PostUp/PostDown, DNS и прочие параметры актуальны даже если конфиг
   * был создан старой версией приложения.
   *
   * С --network host интерфейс wg10/wg11 живёт в ядре хоста и переживает
   * docker stop/start. Если awg-quick up падает с "already exists" —
   * делаем down+up принудительно, чтобы PostUp (iptables MASQUERADE)
   * выполнился с актуальным конфигом.
   */
  async start() {
    // Всегда пересоздаём конфиг — применяем актуальный шаблон
    await this.regenerateConfig();

    try {
      await Util.exec(`${this._quickBin} up ${this.id}`);
    } catch (err) {
      if (err.message && err.message.includes('already exists')) {
        // Интерфейс уже поднят (пережил docker restart в kernel mode).
        // Опускаем и поднимаем заново — только так выполнится PostUp.
        debug(`Interface ${this.id} already exists — cycling down/up to apply PostUp`);
        await Util.exec(`${this._quickBin} down ${this.id}`);
        await Util.exec(`${this._quickBin} up ${this.id}`);
      } else if (err.message && err.message.includes('Address in use')) {
        // IP-адрес занят мусорным маршрутом от предыдущего wg-интерфейса.
        // --network host: интерфейсы переживают контейнеры, маршруты могут остаться
        // даже после удаления интерфейса. Сбрасываем маршрут и поднимаем снова.
        debug(`Interface ${this.id} address in use — flushing stale routes and retrying`);
        const subnet = this.data.address.replace(/\.\d+\/\d+$/, '.0') + '/' + this.data.address.split('/')[1];
        await Util.exec(`ip route del ${subnet} 2>/dev/null || true`);
        await Util.exec(`ip route del ${subnet} table local 2>/dev/null || true`);
        await Util.exec(`${this._quickBin} up ${this.id}`);
      } else {
        throw err;
      }
    }

    this.data.enabled = true;
    await this.save();

    debug(`Interface ${this.id} started`);
  }

  /**
   * Остановить интерфейс
   */
  async stop() {
    try {
      await Util.exec(`${this._quickBin} down ${this.id}`);
    } catch (err) {
      // Игнорируем безопасные ошибки при down:
      // - интерфейс уже остановлен (нормально)
      // - iptables-правила не найдены при PostDown (PostUp мог не выполниться
      //   или правила уже удалены; интерфейс всё равно снят через ip link delete)
      const ignored = [
        'is not a WireGuard interface',
        'is not an AmneziaWG interface',
        'iptables: Bad rule',
        'does a matching rule exist',
      ];
      if (!ignored.some(s => err.message.includes(s))) {
        throw err;
      }
    }

    this.data.enabled = false;
    await this.save();

    debug(`Interface ${this.id} stopped`);
  }

  /**
   * Перезапустить интерфейс
   */
  async restart() {
    await this.stop();
    await this.start();
  }

  /**
   * Атомарно добавить/обновить один peer в работающем ядре.
   * Использует `wg set peer` / `awg set peer` — не трогает [Interface] параметры
   * (H1-H4, Jc, ListenPort и т.д.), только конкретный [Peer].
   * Это безопаснее чем syncconf: нет риска kernel deadlock.
   */
  async _kernelSetPeer(peer) {
    if (!this.data.enabled) return;
    const pskFile = peer.presharedKey ? `/tmp/${this.id}-psk-${peer.id}` : null;
    try {
      if (pskFile) {
        await fs.writeFile(pskFile, peer.presharedKey + '\n', { mode: 0o600 });
      }
      let cmd = `${this._syncBin} set ${this.id} peer ${peer.publicKey}`;
      if (pskFile) cmd += ` preshared-key ${pskFile}`;
      if (peer.allowedIPs) cmd += ` allowed-ips ${peer.allowedIPs}`;
      if (peer.endpoint) cmd += ` endpoint ${peer.endpoint}`;
      if (peer.persistentKeepalive > 0) cmd += ` persistent-keepalive ${peer.persistentKeepalive}`;
      await Util.exec(cmd);
      debug(`Peer ${peer.id} set in kernel (${this.id})`);
    } catch (err) {
      debug(`_kernelSetPeer failed for ${peer.id}: ${err.message}`);
    } finally {
      if (pskFile) await fs.unlink(pskFile).catch(() => {});
    }
  }

  /**
   * Убрать peer из работающего ядра через `wg set peer remove` / `awg set peer remove`.
   *
   * Известный баг AWG kernel module: при паттерне add→remove→add→remove
   * через ~3 итерации команда уходит в D-state (uninterruptible sleep) ядра.
   * WG 1.0 этой проблемы не имеет.
   */
  async _kernelRemovePeer(peerId, publicKey) {
    if (!this.data.enabled) return;
    try {
      await Util.exec(`${this._syncBin} set ${this.id} peer ${publicKey} remove`);
      debug(`Peer ${peerId} removed from kernel (${this.id})`);
    } catch (err) {
      debug(`_kernelRemovePeer failed for ${peerId}: ${err.message}`);
    }
  }

  /**
   * Generate a config suitable for `wg syncconf` / `awg syncconf`.
   * Strips wg-quick-specific directives: Address, Table, PostUp, PostDown, DNS, MTU.
   * These are understood by wg-quick/awg-quick but NOT by the kernel (syncconf).
   * Disabled peers are excluded (toWgConfig() returns '' for them).
   */
  _generateSyncConfig() {
    let config = '[Interface]\n';
    config += `PrivateKey = ${this.data.privateKey}\n`;
    config += `ListenPort = ${this.data.listenPort}\n`;

    // AWG 2.0 kernel params (native to the amneziawg module, accepted by awg syncconf)
    if (this.data.protocol === 'amneziawg-2.0' && this.data.settings) {
      const s = this.data.settings;
      config += `Jc = ${s.jc}\n`;
      config += `Jmin = ${s.jmin}\n`;
      config += `Jmax = ${s.jmax}\n`;
      config += `S1 = ${s.s1}\n`;
      config += `S2 = ${s.s2}\n`;
      config += `S3 = ${s.s3}\n`;
      config += `S4 = ${s.s4}\n`;
      config += `H1 = ${s.h1}\n`;
      config += `H2 = ${s.h2}\n`;
      config += `H3 = ${s.h3}\n`;
      config += `H4 = ${s.h4}\n`;
      if (s.i1) config += `I1 = ${s.i1}\n`;
      if (s.i2) config += `I2 = ${s.i2}\n`;
      if (s.i3) config += `I3 = ${s.i3}\n`;
      if (s.i4) config += `I4 = ${s.i4}\n`;
      if (s.i5) config += `I5 = ${s.i5}\n`;
    }

    // Peers — toWgConfig() returns '' for disabled peers (they're excluded from kernel config)
    for (const peer of this.peers.values()) {
      config += peer.toWgConfig();
    }

    return config;
  }

  /**
   * Перезагрузить конфиг без остановки (hot reload).
   *
   * MUTEX: конкурентные вызовы reload() выстраиваются в очередь.
   * Два одновременных `awg syncconf` на одном устройстве = kernel deadlock.
   * Mutex гарантирует что в любой момент выполняется максимум один syncconf,
   * поэтому process substitution <(awg-quick strip ...) безопасна —
   * параллельной конкуренции за kernel device lock нет.
   *
   * Доказательство: WireGuard.js использует тот же паттерн для wg0 (AWG2)
   * и работает стабильно.
   */
  async reload() {
    // Chain onto the mutex so concurrent calls run sequentially, never in parallel
    this._reloadMutex = this._reloadMutex
      .then(() => this._doReload())
      .catch((err) => {
        debug(`reload mutex chain error (ignored): ${err.message}`);
      });
    return this._reloadMutex;
  }

  async _doReload() {
    try {
      await Util.exec(`${this._syncBin} syncconf ${this.id} <(${this._quickBin} strip ${this.id})`);
      debug(`Interface ${this.id} reloaded (hot)`);
    } catch (err) {
      debug(`Hot reload failed (${err.message})`);
    }
  }

  /**
   * Fetch live status from WireGuard: transfer stats, handshake, endpoint.
   * Sets runtime fields on Peer instances (not persisted to disk).
   */
  async getStatus() {
    if (!this.data.enabled) {
      return;
    }

    try {
      const dump = await Util.exec(`${this._syncBin} show ${this.id} dump`, { log: false });
      const lines = dump.trim().split('\n').slice(1); // skip first line (interface info)

      for (const line of lines) {
        const [publicKey, , endpoint, , latestHandshakeAt, transferRx, transferTx] = line.split('\t');

        const peer = Array.from(this.peers.values()).find(p => p.publicKey === publicKey);
        if (!peer) continue;

        peer.latestHandshakeAt = latestHandshakeAt === '0'
          ? null
          : new Date(Number(`${latestHandshakeAt}000`));
        peer.transferRx = Number(transferRx);
        peer.transferTx = Number(transferTx);
        if (endpoint && endpoint !== '(none)') {
          peer.runtimeEndpoint = endpoint;
        }
      }
    } catch (err) {
      debug(`getStatus failed for ${this.id}: ${err.message}`);
    }
  }

  /**
   * Удалить интерфейс
   */
  async delete() {
    // Остановить
    if (this.data.enabled) {
      await this.stop();
    }
    
    // Удалить peers
    for (const peerId of Array.from(this.peers.keys())) {
      await this.removePeer(peerId);
    }
    
    // Удалить файлы
    await fs.unlink(this.interfaceFile);
    await fs.unlink(this.confFile);
    
    try {
      await fs.rmdir(this.peersDir);
    } catch (err) {
      // Ignore if directory not empty
    }
    
    debug(`Interface ${this.id} deleted`);
  }

  /**
   * Экспорт для API
   */
  toJSON() {
    return {
      id: this.id,
      name: this.data.name,
      protocol: this.data.protocol,
      listenPort: this.data.listenPort,
      address: this.data.address,
      publicKey: this.data.publicKey,
      disableRoutes: this.data.disableRoutes,
      enabled: this.data.enabled,
      createdAt: this.data.createdAt,
      peerCount: this.peers.size,
      peers: Array.from(this.peers.values()).map(p => p.toJSON()),
    };
  }
}

module.exports = TunnelInterface;
