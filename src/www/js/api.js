/* eslint-disable no-unused-vars */
/* eslint-disable no-undef */

'use strict';

class API {

  async call({ method, path, body }) {
    const res = await fetch(`./api${path}`, {
      method: method.toUpperCase(), // Node.js 22 llhttp: HTTP method must be uppercase
      headers: {
        'Content-Type': 'application/json',
      },
      body: body
        ? JSON.stringify(body)
        : undefined,
    });

    if (res.status === 204) {
      return undefined;
    }

    let json;
    try {
      json = await res.json();
    } catch (_) {
      // Сервер вернул пустой или не-JSON body
      throw new Error(`Server error ${res.status}: ${res.statusText}`);
    }

    if (!res.ok) {
      throw new Error(json.message || json.error || res.statusText);
    }

    return json;
  }

  async getRelease() {
    return this.call({
      method: 'get',
      path: '/release',
    });
  }

  async getLang() {
    return this.call({
      method: 'get',
      path: '/lang',
    });
  }

  async getRememberMeEnabled() {
    return this.call({
      method: 'get',
      path: '/remember-me',
    });
  }

  async getuiTrafficStats() {
    return this.call({
      method: 'get',
      path: '/ui-traffic-stats',
    });
  }

  async getChartType() {
    return this.call({
      method: 'get',
      path: '/ui-chart-type',
    });
  }

  async getWGEnableOneTimeLinks() {
    return this.call({
      method: 'get',
      path: '/wg-enable-one-time-links',
    });
  }

  async getWGEnableExpireTime() {
    return this.call({
      method: 'get',
      path: '/wg-enable-expire-time',
    });
  }

  async getAvatarSettings() {
    return this.call({
      method: 'get',
      path: '/ui-avatar-settings',
    });
  }

  async getSession() {
    return this.call({
      method: 'get',
      path: '/session',
    });
  }

  async createSession({ password, remember }) {
    return this.call({
      method: 'post',
      path: '/session',
      body: { password, remember },
    });
  }

  async deleteSession() {
    return this.call({
      method: 'delete',
      path: '/session',
    });
  }

  async getClients() {
    return this.call({
      method: 'get',
      path: '/wireguard/client',
    }).then((clients) => clients.map((client) => ({
      ...client,
      createdAt: new Date(client.createdAt),
      updatedAt: new Date(client.updatedAt),
      expiredAt: client.expiredAt !== null
        ? new Date(client.expiredAt)
        : null,
      latestHandshakeAt: client.latestHandshakeAt !== null
        ? new Date(client.latestHandshakeAt)
        : null,
    })));
  }

  async createClient({ name, expiredDate }) {
    return this.call({
      method: 'post',
      path: '/wireguard/client',
      body: { name, expiredDate },
    });
  }

  async deleteClient({ clientId }) {
    return this.call({
      method: 'delete',
      path: `/wireguard/client/${clientId}`,
    });
  }

  async showOneTimeLink({ clientId }) {
    return this.call({
      method: 'post',
      path: `/wireguard/client/${clientId}/generateOneTimeLink`,
    });
  }

  async enableClient({ clientId }) {
    return this.call({
      method: 'post',
      path: `/wireguard/client/${clientId}/enable`,
    });
  }

  async disableClient({ clientId }) {
    return this.call({
      method: 'post',
      path: `/wireguard/client/${clientId}/disable`,
    });
  }

  async updateClientName({ clientId, name }) {
    return this.call({
      method: 'put',
      path: `/wireguard/client/${clientId}/name/`,
      body: { name },
    });
  }

  async updateClientAddress({ clientId, address }) {
    return this.call({
      method: 'put',
      path: `/wireguard/client/${clientId}/address/`,
      body: { address },
    });
  }

  async updateClientExpireDate({ clientId, expireDate }) {
    return this.call({
      method: 'put',
      path: `/wireguard/client/${clientId}/expireDate/`,
      body: { expireDate },
    });
  }

  async restoreConfiguration(file) {
    return this.call({
      method: 'put',
      path: '/wireguard/restore',
      body: { file },
    });
  }

  async getUiSortClients() {
    return this.call({
      method: 'get',
      path: '/ui-sort-clients',
    });
  }

  // ============================================================
  // Settings API
  // ============================================================

  async getSettings() {
    return this.call({
      method: 'get',
      path: '/settings',
    });
  }

  async updateSettings(settings) {
    return this.call({
      method: 'put',
      path: '/settings',
      body: settings,
    });
  }

  // ============================================================
  // AWG2 Templates API
  // ============================================================

  async getTemplates() {
    return this.call({
      method: 'get',
      path: '/templates',
    });
  }

  async createTemplate(template) {
    return this.call({
      method: 'post',
      path: '/templates',
      body: template,
    });
  }

  async updateTemplate({ templateId, ...updates }) {
    return this.call({
      method: 'put',
      path: `/templates/${templateId}`,
      body: updates,
    });
  }

  async deleteTemplate({ templateId }) {
    return this.call({
      method: 'delete',
      path: `/templates/${templateId}`,
    });
  }

  async setDefaultTemplate({ templateId }) {
    return this.call({
      method: 'post',
      path: `/templates/${templateId}/set-default`,
    });
  }

  /**
   * Get AWG2 settings from a template.
   * H1-H4 are copied as-is (ranges). The AWG protocol randomises within the range per handshake.
   * Used when the user selects "Load from template" in the Instance form.
   */
  async applyTemplate({ templateId }) {
    return this.call({
      method: 'post',
      path: `/templates/${templateId}/apply`,
    });
  }

  /**
   * generateTemplate — сгенерировать AWG 2.0 параметры (порт AmneziaWG-Architect).
   * @param {object} opts
   * @param {string} [opts.profile]    — профиль CPS ('random', 'quic_initial', 'tls_client_hello', ...)
   * @param {string} [opts.intensity]  — интенсивность ('low', 'medium', 'high')
   * @param {string} [opts.host]       — кастомный хост для SNI
   * @param {number} [opts.iterCount]  — счётчик попыток
   * @param {number} [opts.jc]         — базовое Jc
   * @param {string} [opts.saveName]   — если задан, сохраняет как шаблон
   * @returns {{ params, profiles[, template] }}
   */
  async generateTemplate({ profile, intensity, host, iterCount, jc, saveName } = {}) {
    return this.call({
      method: 'post',
      path: '/templates/generate',
      body: { profile, intensity, host, iterCount, jc, saveName },
    });
  }

  // ============================================================
  // Tunnel Interfaces API
  // ============================================================

  async getTunnelInterfaces() {
    return this.call({
      method: 'get',
      path: '/tunnel-interfaces',
    });
  }

  async createTunnelInterface(data) {
    return this.call({
      method: 'post',
      path: '/tunnel-interfaces',
      body: data,
    });
  }

  async updateTunnelInterface({ interfaceId, ...updates }) {
    return this.call({
      method: 'patch',
      path: `/tunnel-interfaces/${interfaceId}`,
      body: updates,
    });
  }

  async deleteTunnelInterface({ interfaceId }) {
    return this.call({
      method: 'delete',
      path: `/tunnel-interfaces/${interfaceId}`,
    });
  }

  async startTunnelInterface({ interfaceId }) {
    return this.call({
      method: 'post',
      path: `/tunnel-interfaces/${interfaceId}/start`,
    });
  }

  async stopTunnelInterface({ interfaceId }) {
    return this.call({
      method: 'post',
      path: `/tunnel-interfaces/${interfaceId}/stop`,
    });
  }

  async restartTunnelInterface({ interfaceId }) {
    return this.call({
      method: 'post',
      path: `/tunnel-interfaces/${interfaceId}/restart`,
    });
  }

  // ============================================================
  // Peers API (for Tunnel Interfaces)
  // ============================================================

  async getTunnelInterfacePeers({ interfaceId }) {
    return this.call({
      method: 'get',
      path: `/tunnel-interfaces/${interfaceId}/peers`,
    });
  }

  async createTunnelInterfacePeer({ interfaceId, ...peerData }) {
    return this.call({
      method: 'post',
      path: `/tunnel-interfaces/${interfaceId}/peers`,
      body: peerData,
    });
  }

  async updateTunnelInterfacePeer({ interfaceId, peerId, ...updates }) {
    return this.call({
      method: 'patch',
      path: `/tunnel-interfaces/${interfaceId}/peers/${peerId}`,
      body: updates,
    });
  }

  async deleteTunnelInterfacePeer({ interfaceId, peerId }) {
    return this.call({
      method: 'delete',
      path: `/tunnel-interfaces/${interfaceId}/peers/${peerId}`,
    });
  }

  async enablePeer({ interfaceId, peerId }) {
    return this.call({
      method: 'post',
      path: `/tunnel-interfaces/${interfaceId}/peers/${peerId}/enable`,
    });
  }

  async disablePeer({ interfaceId, peerId }) {
    return this.call({
      method: 'post',
      path: `/tunnel-interfaces/${interfaceId}/peers/${peerId}/disable`,
    });
  }

  async updatePeerName({ interfaceId, peerId, name }) {
    return this.call({
      method: 'put',
      path: `/tunnel-interfaces/${interfaceId}/peers/${peerId}/name`,
      body: { name },
    });
  }

  async updatePeerAddress({ interfaceId, peerId, address }) {
    return this.call({
      method: 'put',
      path: `/tunnel-interfaces/${interfaceId}/peers/${peerId}/address`,
      body: { address },
    });
  }

  async updatePeerExpireDate({ interfaceId, peerId, expireDate }) {
    return this.call({
      method: 'put',
      path: `/tunnel-interfaces/${interfaceId}/peers/${peerId}/expireDate`,
      body: { expireDate },
    });
  }

  async generatePeerOneTimeLink({ interfaceId, peerId }) {
    return this.call({
      method: 'post',
      path: `/tunnel-interfaces/${interfaceId}/peers/${peerId}/generateOneTimeLink`,
    });
  }

  /**
   * Экспортировать параметры Interconnect пира в JSON.
   * Возвращает объект для передачи удалённой стороне (та импортирует через importPeerJSON).
   * Доступен только для пиров с peerType === 'interconnect'.
   * Поля: name, publicKey, presharedKey, endpoint, persistentKeepalive, allowedIPs, clientAllowedIPs.
   */
  async exportPeerJSON({ interfaceId, peerId }) {
    return this.call({
      method: 'get',
      path: `/tunnel-interfaces/${interfaceId}/peers/${peerId}/export-json`,
    });
  }

  /**
   * Создать Interconnect пир из JSON экспортированного другой стороной.
   * peerData — объект полученный от exportPeerJSON() удалённой стороны.
   * peerType автоматически устанавливается в 'interconnect'.
   * Ключи не генерируются — они содержатся в импортируемом JSON.
   */
  async importPeerJSON({ interfaceId, ...peerData }) {
    return this.call({
      method: 'post',
      path: `/tunnel-interfaces/${interfaceId}/peers/import-json`,
      body: peerData,
    });
  }

  /**
   * Экспортировать AWG2 параметры обфускации интерфейса.
   * Возвращает объект с Jc, Jmin, Jmax, S1-S4, H1-H4, I1-I5.
   * Формат совместим с createTemplate() — можно сохранить как профиль.
   * Ошибка 400 если интерфейс не AWG2.
   */
  async exportObfuscationParams({ interfaceId }) {
    return this.call({
      method: 'get',
      path: `/tunnel-interfaces/${interfaceId}/export-obfuscation`,
    });
  }

  /**
   * Экспортировать параметры своего интерфейса для передачи удалённой стороне.
   * Удалённая сторона импортирует JSON через importPeerJSON() → создаёт пир для нас.
   * Возвращает: name, publicKey, endpoint, address, protocol, settings (AWG2 only).
   */
  async exportInterfaceParams({ interfaceId }) {
    return this.call({
      method: 'get',
      path: `/tunnel-interfaces/${interfaceId}/export-params`,
    });
  }

  async backupTunnelInterface({ interfaceId }) {
    return this.call({
      method: 'get',
      path: `/tunnel-interfaces/${interfaceId}/backup`,
    });
  }

  async restoreTunnelInterface({ interfaceId, file }) {
    return this.call({
      method: 'put',
      path: `/tunnel-interfaces/${interfaceId}/restore`,
      body: { file },
    });
  }

  // ============================================================
  // System Interfaces API
  // ============================================================

  async getSystemInterfaces() {
    return this.call({
      method: 'get',
      path: '/system/interfaces',
    });
  }

  // ============================================================
  // Gateways API
  // ============================================================

  async getGateways() {
    return this.call({
      method: 'get',
      path: '/gateways',
    });
  }

  async createGateway(data) {
    return this.call({
      method: 'post',
      path: '/gateways',
      body: data,
    });
  }

  async updateGateway({ gatewayId, ...updates }) {
    return this.call({
      method: 'patch',
      path: `/gateways/${gatewayId}`,
      body: updates,
    });
  }

  async deleteGateway({ gatewayId }) {
    return this.call({
      method: 'delete',
      path: `/gateways/${gatewayId}`,
    });
  }

  // ============================================================
  // Gateway Groups API
  // ============================================================

  async getGatewayGroups() {
    return this.call({
      method: 'get',
      path: '/gateway-groups',
    });
  }

  async createGatewayGroup(data) {
    return this.call({
      method: 'post',
      path: '/gateway-groups',
      body: data,
    });
  }

  async updateGatewayGroup({ groupId, ...updates }) {
    return this.call({
      method: 'patch',
      path: `/gateway-groups/${groupId}`,
      body: updates,
    });
  }

  async deleteGatewayGroup({ groupId }) {
    return this.call({
      method: 'delete',
      path: `/gateway-groups/${groupId}`,
    });
  }

  // ============================================================
  // Routing API
  // ============================================================

  async getRoutingTables() {
    return this.call({
      method: 'get',
      path: '/routing/tables',
    });
  }

  async getKernelRoutes(table = 'main') {
    return this.call({
      method: 'get',
      path: `/routing/table?table=${encodeURIComponent(table)}`,
    });
  }

  async testRoute(ip) {
    return this.call({
      method: 'get',
      path: `/routing/test?ip=${encodeURIComponent(ip)}`,
    });
  }

  async getStaticRoutes() {
    return this.call({
      method: 'get',
      path: '/routing/routes',
    });
  }

  async createStaticRoute(data) {
    return this.call({
      method: 'post',
      path: '/routing/routes',
      body: data,
    });
  }

  async toggleStaticRoute({ routeId, enabled }) {
    return this.call({
      method: 'patch',
      path: `/routing/routes/${routeId}`,
      body: { enabled },
    });
  }

  async deleteStaticRoute({ routeId }) {
    return this.call({
      method: 'delete',
      path: `/routing/routes/${routeId}`,
    });
  }

  // ============================================================
  // NAT API — Source NAT (POSTROUTING)
  // ============================================================

  /**
   * Получить список сетевых интерфейсов хоста.
   * Используется для выбора outbound-интерфейса при создании NAT правила.
   * @returns {{ interfaces: Array<{name: string}> }}
   */
  async getNatInterfaces() {
    return this.call({
      method: 'get',
      path: '/nat/interfaces',
    });
  }

  /**
   * Получить список NAT правил.
   * @returns {{ rules: Array<object> }}
   */
  async getNatRules() {
    return this.call({
      method: 'get',
      path: '/nat/rules',
    });
  }

  /**
   * Создать новое NAT правило.
   * @param {object} data - { name, source, outInterface, type, toSource, comment }
   * @returns {{ rule: object }}
   */
  async createNatRule(data) {
    return this.call({
      method: 'post',
      path: '/nat/rules',
      body: data,
    });
  }

  /**
   * Обновить NAT правило (полное обновление полей).
   * @param {{ ruleId: string, name, source, outInterface, type, toSource, comment }}
   * @returns {{ rule: object }}
   */
  async updateNatRule({ ruleId, ...updates }) {
    return this.call({
      method: 'patch',
      path: `/nat/rules/${ruleId}`,
      body: updates,
    });
  }

  /**
   * Включить / выключить NAT правило (toggle).
   * @param {{ ruleId: string, enabled: boolean }}
   * @returns {{ rule: object }}
   */
  async toggleNatRule({ ruleId, enabled }) {
    return this.call({
      method: 'patch',
      path: `/nat/rules/${ruleId}`,
      body: { enabled },
    });
  }

  /**
   * Удалить NAT правило.
   * @param {{ ruleId: string }}
   */
  async deleteNatRule({ ruleId }) {
    return this.call({
      method: 'delete',
      path: `/nat/rules/${ruleId}`,
    });
  }

}
