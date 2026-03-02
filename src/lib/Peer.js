const { v4: uuidv4 } = require('uuid');
const debug = require('debug')('awg:peer');

/**
 * Peer - удалённое подключение к интерфейсу
 * Представляет одну удалённую сторону в Site-to-Site VPN
 */
class Peer {
  /**
   * @param {Object} data - данные peer
   * @param {string} data.id - UUID peer (генерируется если не указан)
   * @param {string} data.name - friendly name (например "Office-A")
   * @param {string} data.interfaceId - к какому интерфейсу принадлежит (например "wg10")
   * @param {string} data.publicKey - публичный ключ удалённой стороны
   * @param {string} data.presharedKey - pre-shared key (опционально)
   * @param {string} data.endpoint - endpoint удалённой стороны (например "office-a.com:51820")
   * @param {string} data.allowedIPs - разрешённые IP/подсети (например "192.168.1.0/24")
   * @param {number} data.persistentKeepalive - keepalive в секундах (default 25)
   * @param {string} data.remoteAddress - IP адрес удалённой стороны в туннеле (например "10.100.0.2/24")
   * @param {boolean} data.enabled - включен ли peer
   * @param {string} data.createdAt - дата создания
   */
  constructor(data) {
    this.id = data.id || uuidv4();
    this.name = data.name;
    this.interfaceId = data.interfaceId;
    this.publicKey = data.publicKey;
    this.privateKey = data.privateKey || ''; // только для server-generated пиров
    this.presharedKey = data.presharedKey || '';
    this.endpoint = data.endpoint || '';
    this.allowedIPs = data.allowedIPs;           // AllowedIPs на стороне хаба (что хаб маршрутизирует к пиру)
    this.clientAllowedIPs = data.clientAllowedIPs || ''; // AllowedIPs в клиентском конфиге
    this.peerType = data.peerType || 'site';     // 'client' (мобильный/динамический IP) | 'site' (фиксированный IP)
    this.persistentKeepalive = data.persistentKeepalive || 25;
    this.remoteAddress = data.remoteAddress || '';
    this.enabled = data.enabled !== false; // default true
    this.createdAt = data.createdAt || new Date().toISOString();
    
    debug(`Peer created: ${this.id} (${this.name}) for interface ${this.interfaceId}`);
  }

  /**
   * Конвертировать в JSON для сохранения
   */
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      interfaceId: this.interfaceId,
      publicKey: this.publicKey,
      privateKey: this.privateKey,
      presharedKey: this.presharedKey,
      endpoint: this.endpoint,
      allowedIPs: this.allowedIPs,
      clientAllowedIPs: this.clientAllowedIPs,
      peerType: this.peerType,
      persistentKeepalive: this.persistentKeepalive,
      remoteAddress: this.remoteAddress,
      enabled: this.enabled,
      createdAt: this.createdAt,
      hasGeneratedKeys: !!this.privateKey, // для UI: знать что QR доступен
    };
  }

  /**
   * Валидация данных peer
   */
  validate() {
    const errors = [];
    
    if (!this.name || this.name.trim() === '') {
      errors.push('Peer name is required');
    }
    
    if (!this.interfaceId) {
      errors.push('Interface ID is required');
    }
    
    if (!this.publicKey || this.publicKey.length !== 44) {
      errors.push('Invalid public key (must be 44 characters base64)');
    }
    
    if (!this.allowedIPs) {
      errors.push('AllowedIPs is required');
    }
    
    // Валидация формата AllowedIPs (базовая)
    if (this.allowedIPs) {
      const ips = this.allowedIPs.split(',').map(ip => ip.trim());
      for (const ip of ips) {
        if (!this._isValidCIDR(ip)) {
          errors.push(`Invalid AllowedIPs format: ${ip}`);
        }
      }
    }
    
    // Валидация endpoint (опционально)
    if (this.endpoint && !this._isValidEndpoint(this.endpoint)) {
      errors.push('Invalid endpoint format (should be host:port)');
    }
    
    return errors;
  }

  /**
   * Проверка валидности CIDR нотации
   */
  _isValidCIDR(cidr) {
    // Упрощённая валидация (можно улучшить)
    const pattern = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
    return pattern.test(cidr);
  }

  /**
   * Проверка валидности endpoint
   */
  _isValidEndpoint(endpoint) {
    // host:port
    const pattern = /^.+:\d+$/;
    return pattern.test(endpoint);
  }

  /**
   * Генерация секции [Peer] для WireGuard конфига
   */
  toWgConfig() {
    if (!this.enabled) {
      return ''; // Disabled peer не добавляется в конфиг
    }
    
    let config = `\n[Peer]\n`;
    config += `# ${this.name}\n`;
    config += `PublicKey = ${this.publicKey}\n`;
    
    if (this.presharedKey) {
      config += `PresharedKey = ${this.presharedKey}\n`;
    }
    
    config += `AllowedIPs = ${this.allowedIPs}\n`;
    
    if (this.endpoint) {
      config += `Endpoint = ${this.endpoint}\n`;
    }
    
    if (this.persistentKeepalive > 0) {
      config += `PersistentKeepalive = ${this.persistentKeepalive}\n`;
    }
    
    return config;
  }

  /**
   * Генерация конфига для удалённой стороны.
   * Если у пира есть privateKey (server-generated) — полный готовый конфиг (для QR).
   * Если нет — шаблон с инструкциями (для ручной настройки).
   * @param {Object} interfaceData - данные интерфейса к которому подключается peer
   */
  generateRemoteConfig(interfaceData) {
    return this.privateKey
      ? this._generateCompleteConfig(interfaceData)
      : this._generateTemplateConfig(interfaceData);
  }

  /**
   * Полный рабочий конфиг (когда ключи сгенерированы сервером).
   * Минимум комментариев — важно для QR-кода (ограниченная ёмкость).
   */
  _generateCompleteConfig(interfaceData) {
    let config = '[Interface]\n';
    config += `PrivateKey = ${this.privateKey}\n`;

    // Address = IP пира с маской интерфейса (вычисляется, не хранится)
    if (this.allowedIPs && interfaceData.address) {
      const peerIp = this.allowedIPs.split('/')[0];
      const ifaceMask = interfaceData.address.split('/')[1] || '24';
      config += `Address = ${peerIp}/${ifaceMask}\n`;
    }

    // DNS — include for client peers (full-tunnel, peerType === 'client').
    // Site-to-site peers handle DNS on their own network.
    if (this.peerType === 'client' || !this.peerType) {
      const dns = process.env.WG_DEFAULT_DNS || '1.1.1.1, 8.8.8.8';
      config += `DNS = ${dns}\n`;
    }

    if (interfaceData.protocol === 'amneziawg-2.0' && interfaceData.settings) {
      const s = interfaceData.settings;
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

    config += '\n[Peer]\n';
    config += `PublicKey = ${interfaceData.publicKey}\n`;

    if (this.presharedKey) {
      config += `PresharedKey = ${this.presharedKey}\n`;
    }

    const hubEndpoint = process.env.WG_HOST || '';
    if (hubEndpoint) {
      config += `Endpoint = ${hubEndpoint}:${interfaceData.listenPort}\n`;
    }

    // AllowedIPs в клиентском конфиге:
    // - client-пир: весь трафик через VPN (или кастомное значение)
    // - site-пир: только сеть хаба
    const clientAllowedIPs = this.clientAllowedIPs
      || (this.peerType === 'client' ? '0.0.0.0/0, ::/0' : interfaceData.address || '0.0.0.0/0, ::/0');
    config += `AllowedIPs = ${clientAllowedIPs}\n`;

    config += `PersistentKeepalive = ${this.persistentKeepalive}\n`;

    return config;
  }

  /**
   * Шаблон конфига с инструкциями (когда ключи вводились вручную).
   */
  _generateTemplateConfig(interfaceData) {
    let config = '';

    config += '# ═══════════════════════════════════════════════════════════════\n';
    config += `# Remote Configuration for: ${this.name}\n`;
    config += `# Connect to: ${interfaceData.name}\n`;
    config += `# Protocol: ${interfaceData.protocol === 'amneziawg-2.0' ? 'AmneziaWG 2.0' : 'WireGuard 1.0'}\n`;
    config += '# ═══════════════════════════════════════════════════════════════\n\n';

    config += '[Interface]\n';
    config += '# IMPORTANT: Generate your own private key on remote side:\n';
    config += '#   wg genkey > privatekey\n';
    config += '#   cat privatekey | wg pubkey > publickey\n';
    config += '# Then replace YOUR_PRIVATE_KEY with content of privatekey\n';
    config += 'PrivateKey = YOUR_PRIVATE_KEY\n\n';
    config += '# Listen port (choose any free UDP port)\n';
    config += 'ListenPort = 51820\n\n';

    // Address = IP пира с маской интерфейса (вычисляется, не хранится)
    if (this.allowedIPs && interfaceData.address) {
      const peerIp = this.allowedIPs.split('/')[0];
      const ifaceMask = interfaceData.address.split('/')[1] || '24';
      config += `Address = ${peerIp}/${ifaceMask}\n`;
    }

    if (this.peerType === 'client' || !this.peerType) {
      const dns = process.env.WG_DEFAULT_DNS || '1.1.1.1, 8.8.8.8';
      config += `DNS = ${dns}\n`;
    }
    config += '\n';

    if (interfaceData.protocol === 'amneziawg-2.0' && interfaceData.settings) {
      const s = interfaceData.settings;
      config += '# AmneziaWG 2.0 Parameters (MUST match EXACTLY on both sides!)\n';
      config += `Jc = ${s.jc}\nJmin = ${s.jmin}\nJmax = ${s.jmax}\n`;
      config += `S1 = ${s.s1}\nS2 = ${s.s2}\nS3 = ${s.s3}\nS4 = ${s.s4}\n`;
      config += `H1 = ${s.h1}\nH2 = ${s.h2}\nH3 = ${s.h3}\nH4 = ${s.h4}\n`;
      if (s.i1) config += `I1 = ${s.i1}\n`;
      if (s.i2) config += `I2 = ${s.i2}\n`;
      if (s.i3) config += `I3 = ${s.i3}\n`;
      if (s.i4) config += `I4 = ${s.i4}\n`;
      if (s.i5) config += `I5 = ${s.i5}\n`;
      config += '\n';
    }

    config += '[Peer]\n';
    config += `PublicKey = ${interfaceData.publicKey}\n\n`;

    const hubEndpoint = process.env.WG_HOST || 'YOUR_HUB_PUBLIC_IP';
    config += `Endpoint = ${hubEndpoint}:${interfaceData.listenPort}\n`;

    const clientAllowedIPs = this.clientAllowedIPs
      || (this.peerType === 'client' ? '0.0.0.0/0, ::/0' : interfaceData.address || '0.0.0.0/0');
    config += `AllowedIPs = ${clientAllowedIPs}\n`;

    config += `PersistentKeepalive = ${this.persistentKeepalive}\n\n`;

    config += '# ═══════════════════════════════════════════════════════════════\n';
    config += '# 1. Generate keys: wg genkey | tee privatekey | wg pubkey > publickey\n';
    config += '# 2. Replace YOUR_PRIVATE_KEY above\n';
    config += '# 3. Add your public key to hub peer configuration\n';
    config += `# 4. Run: ${interfaceData.protocol === 'amneziawg-2.0' ? 'awg-quick' : 'wg-quick'} up wg0\n`;
    config += '# ═══════════════════════════════════════════════════════════════\n';

    return config;
  }
}

module.exports = Peer;
