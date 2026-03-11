/* eslint-disable no-console */
/* eslint-disable no-alert */
/* eslint-disable no-undef */
/* eslint-disable no-new */

'use strict';

function bytes(bytes, decimals, kib, maxunit) {
  kib = kib || false;
  if (bytes === 0) return '0 B';
  if (Number.isNaN(parseFloat(bytes)) && !Number.isFinite(bytes)) return 'NaN';
  const k = kib ? 1024 : 1000;
  const dm = decimals != null && !Number.isNaN(decimals) && decimals >= 0 ? decimals : 2;
  const sizes = kib
    ? ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB', 'BiB']
    : ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB', 'BB'];
  let i = Math.floor(Math.log(bytes) / Math.log(k));
  if (maxunit !== undefined) {
    const index = sizes.indexOf(maxunit);
    if (index !== -1) i = index;
  }
  // eslint-disable-next-line no-restricted-properties
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * Sorts an array of objects by a specified property in ascending or descending order.
 *
 * @param {Array} array - The array of objects to be sorted.
 * @param {string} property - The property to sort the array by.
 * @param {boolean} [sort=true] - Whether to sort the array in ascending (default) or descending order.
 * @return {Array} - The sorted array of objects.
 */
function sortByProperty(array, property, sort = true) {
  if (sort) {
    return array.sort((a, b) => (typeof a[property] === 'string' ? a[property].localeCompare(b[property]) : a[property] - b[property]));
  }

  return array.sort((a, b) => (typeof a[property] === 'string' ? b[property].localeCompare(a[property]) : b[property] - a[property]));
}

const i18n = new VueI18n({
  locale: localStorage.getItem('lang') || 'en',
  fallbackLocale: 'en',
  messages,
});

const UI_CHART_TYPES = [
  { type: false, strokeWidth: 0 },
  { type: 'line', strokeWidth: 3 },
  { type: 'area', strokeWidth: 0 },
  { type: 'bar', strokeWidth: 0 },
];

const CHART_COLORS = {
  rx: { light: 'rgba(128,128,128,0.3)', dark: 'rgba(255,255,255,0.3)' },
  tx: { light: 'rgba(128,128,128,0.4)', dark: 'rgba(255,255,255,0.3)' },
  gradient: { light: ['rgba(0,0,0,1.0)', 'rgba(0,0,0,1.0)'], dark: ['rgba(128,128,128,0)', 'rgba(128,128,128,0)'] },
};

new Vue({
  el: '#app',
  components: {
    apexchart: VueApexCharts,
  },
  i18n,
  data: {
    authenticated: null,
    authenticating: false,
    password: null,
    requiresPassword: null,
    remember: false,
    rememberMeEnabled: false,

    clients: null,
    clientsPersist: {},
    clientDelete: null,
    clientCreate: null,
    clientCreateName: '',
    clientExpiredDate: '',
    clientEditName: null,
    clientEditNameId: null,
    clientEditAddress: null,
    clientEditAddressId: null,
    clientEditExpireDate: null,
    clientEditExpireDateId: null,
    qrcode: null,

    currentRelease: null,
    latestRelease: null,

    uiTrafficStats: false,

    uiChartType: 0,
    avatarSettings: {
      'dicebear': null,
      'gravatar': false,
    },
    enableOneTimeLinks: false,
    enableSortClient: false,
    sortClient: true, // Sort clients by name, true = asc, false = desc
    enableExpireTime: false,

    // Sidebar navigation
    activePage: 'interfaces', // 'interfaces' | 'gateways' | 'routing' | 'firewall' | 'settings' | 'administration'
    activeInterfaceId: null,  // ID выбранного интерфейса (вкладка)
    hoverPage: null,          // для hover-эффекта в sidebar
    sidebarMenu: [
      { id: 'interfaces', label: 'Interfaces' },
      { id: 'gateways', label: 'Gateways' },
      { id: 'routing', label: 'Routing' },
      { id: 'firewall', label: 'Firewall / NAT' },
      { id: 'settings', label: 'Settings' },
      { id: 'administration', label: 'Administration' },
    ],

    // Tunnel Interfaces
    tunnelInterfaces: [],
    selectedInterface: null,
    selectedInterfacePeers: [],
    allPeers: [],            // dashboard: flat list of peers from all interfaces
    showInterfaceCreate: false,
    showInterfaceEdit: false,
    interfaceEdit: {
      id: null,
      name: '',
      address: '',
      listenPort: '',
      disableRoutes: false,
      protocol: 'wireguard-1.0',
      selectedTemplateId: '',
      settings: {
        jc: 6, jmin: 10, jmax: 50,
        s1: 64, s2: 67, s3: 64, s4: 4,
        h1: '', h2: '', h3: '', h4: '',
        i1: '', i2: '', i3: '', i4: '', i5: '',
      },
    },
    showPeerCreate: false, // manual peer create modal
    showQuickPeerCreate: false, // quick peer create dialog
    loadingInterfaceId: null,
    interfaceCreate: {
      name: '',
      protocol: 'wireguard-1.0',
      address: '',
      listenPort: '',
      disableRoutes: false,
      selectedTemplateId: '',   // UI-only: выбранный профиль обфускации (не отправляется в API)
      settings: {
        jc: 6, jmin: 10, jmax: 50,
        s1: 64, s2: 67, s3: 64, s4: 4,
        h1: '', h2: '', h3: '', h4: '',
        i1: '', i2: '', i3: '', i4: '', i5: '',
      },
    },
    peerCreate: {
      mode: 'generate',     // 'generate' | 'manual'
      peerType: 'client',   // 'client' | 'interconnect'
      name: '',
      publicKey: '',
      endpoint: '',
      allowedIPs: '',
      clientAllowedIPs: '',
      persistentKeepalive: 25,
    },

    // Quick peer create (one-click)
    peerCreateName: '',
    peerCreateExpiredDate: '',

    // Peer management (inline editing, admin-tunnel style)
    peersPersist: {},
    peerDelete: null, // peer for delete confirmation modal
    peerEditNameId: null,
    peerEditName: null,
    peerEditAddressId: null,
    peerEditAddress: null,
    peerEditExpireDateId: null,
    peerEditExpireDate: null,
    // Settings
    globalSettings: {
      dns: '1.1.1.1, 8.8.8.8',
      defaultPersistentKeepalive: 25,
      defaultClientAllowedIPs: '0.0.0.0/0, ::/0',
      gatewayWindowSeconds:     30,
      gatewayHealthyThreshold:  95,
      gatewayDegradedThreshold: 90,
    },
    settingsSaved: false,
    templates: [],
    showTemplateModal: false,
    templateEditTarget: null, // null = create, object = edit
    templateForm: {
      name: '',
      isDefault: false,
      jc: 6, jmin: 10, jmax: 50,
      s1: 64, s2: 67, s3: 64, s4: 4,
      h1: '', h2: '', h3: '', h4: '',
      i1: '', i2: '', i3: '', i4: '', i5: '',
    },

    // Gateways
    gateways: [],
    gatewayGroups: [],
    systemInterfaces: [],
    showGatewayCreate: false,
    showGatewayEdit:   false,
    showGroupCreate:   false,
    showGroupEdit:     false,
    gatewayCreate: {
      name: '',
      interface: '',
      gatewayIP: '',
      monitorAddress: '',
      monitor: true,
      monitorInterval: 5,
      windowSeconds: null,
      latencyThreshold: 500,
      description: '',
    },
    gatewayEdit: {
      id: null,
      name: '',
      interface: '',
      gatewayIP: '',
      monitorAddress: '',
      monitor: true,
      monitorInterval: 5,
      windowSeconds: null,
      latencyThreshold: 500,
      description: '',
    },
    groupCreate: { name: '', trigger: 'packetloss', description: '', gateways: [] },
    groupEdit:   { id: null, name: '', trigger: 'packetloss', description: '', gateways: [] },

    // Routing page
    activeRoutingTab: 'status',   // 'status' | 'static' | 'ospf'
    routingTable: 'main',         // таблица для Status tab
    routingTables: [],            // список таблиц из /etc/iproute2/rt_tables
    kernelRoutes: [],
    kernelRoutesError: '',
    kernelRoutesLoading: false,
    staticRoutes: [],
    routeTestIp: '',
    routeTestResult: null,
    routeTestLoading: false,
    routeTestError: '',
    showRouteCreate: false,
    routeCreate: {
      description: '',
      destination: '',
      gateway: '',
      dev: '',
      metric: '',
      table: 'main',
    },

    uiShowCharts: localStorage.getItem('uiShowCharts') === '1',
    uiTheme: localStorage.theme || 'auto',
    prefersDarkScheme: window.matchMedia('(prefers-color-scheme: dark)'),

    chartOptions: {
      chart: {
        background: 'transparent',
        stacked: false,
        toolbar: {
          show: false,
        },
        animations: {
          enabled: false,
        },
        parentHeightOffset: 0,
        sparkline: {
          enabled: true,
        },
      },
      colors: [],
      stroke: {
        curve: 'smooth',
      },
      fill: {
        type: 'gradient',
        gradient: {
          shade: 'dark',
          type: 'vertical',
          shadeIntensity: 0,
          gradientToColors: CHART_COLORS.gradient[this.theme],
          inverseColors: false,
          opacityTo: 0,
          stops: [0, 100],
        },
      },
      dataLabels: {
        enabled: false,
      },
      plotOptions: {
        bar: {
          horizontal: false,
        },
      },
      xaxis: {
        labels: {
          show: false,
        },
        axisTicks: {
          show: false,
        },
        axisBorder: {
          show: false,
        },
      },
      yaxis: {
        labels: {
          show: false,
        },
        min: 0,
      },
      tooltip: {
        enabled: false,
      },
      legend: {
        show: false,
      },
      grid: {
        show: false,
        padding: {
          left: -10,
          right: 0,
          bottom: -15,
          top: -15,
        },
        column: {
          opacity: 0,
        },
        xaxis: {
          lines: {
            show: false,
          },
        },
      },
    },

  },
  methods: {
    dateTime: (value) => {
      return new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
      }).format(value);
    },
    async refresh({
      updateCharts = false,
    } = {}) {
      if (!this.authenticated) return;

      const clients = await this.api.getClients();
      this.clients = clients.map((client) => {
        if (client.name.includes('@') && client.name.includes('.') && this.avatarSettings.gravatar) {
          client.avatar = `https://gravatar.com/avatar/${sha256(client.name.toLowerCase().trim())}.jpg`;
        } else if (this.avatarSettings.dicebear) {
          client.avatar = `https://api.dicebear.com/9.x/${this.avatarSettings.dicebear}/svg?seed=${sha256(client.name.toLowerCase().trim())}`
        }

        if (!this.clientsPersist[client.id]) {
          this.clientsPersist[client.id] = {};
          this.clientsPersist[client.id].transferRxHistory = Array(50).fill(0);
          this.clientsPersist[client.id].transferRxPrevious = client.transferRx;
          this.clientsPersist[client.id].transferTxHistory = Array(50).fill(0);
          this.clientsPersist[client.id].transferTxPrevious = client.transferTx;
        }

        // Debug
        // client.transferRx = this.clientsPersist[client.id].transferRxPrevious + Math.random() * 1000;
        // client.transferTx = this.clientsPersist[client.id].transferTxPrevious + Math.random() * 1000;
        // client.latestHandshakeAt = new Date();
        // this.requiresPassword = true;

        this.clientsPersist[client.id].transferRxCurrent = client.transferRx - this.clientsPersist[client.id].transferRxPrevious;
        this.clientsPersist[client.id].transferRxPrevious = client.transferRx;
        this.clientsPersist[client.id].transferTxCurrent = client.transferTx - this.clientsPersist[client.id].transferTxPrevious;
        this.clientsPersist[client.id].transferTxPrevious = client.transferTx;

        if (updateCharts) {
          this.clientsPersist[client.id].transferRxHistory.push(this.clientsPersist[client.id].transferRxCurrent);
          this.clientsPersist[client.id].transferRxHistory.shift();

          this.clientsPersist[client.id].transferTxHistory.push(this.clientsPersist[client.id].transferTxCurrent);
          this.clientsPersist[client.id].transferTxHistory.shift();

          this.clientsPersist[client.id].transferTxSeries = [{
            name: 'Tx',
            data: this.clientsPersist[client.id].transferTxHistory,
          }];

          this.clientsPersist[client.id].transferRxSeries = [{
            name: 'Rx',
            data: this.clientsPersist[client.id].transferRxHistory,
          }];

          client.transferTxHistory = this.clientsPersist[client.id].transferTxHistory;
          client.transferRxHistory = this.clientsPersist[client.id].transferRxHistory;
          client.transferMax = Math.max(...client.transferTxHistory, ...client.transferRxHistory);

          client.transferTxSeries = this.clientsPersist[client.id].transferTxSeries;
          client.transferRxSeries = this.clientsPersist[client.id].transferRxSeries;
        }

        client.transferTxCurrent = this.clientsPersist[client.id].transferTxCurrent;
        client.transferRxCurrent = this.clientsPersist[client.id].transferRxCurrent;

        client.hoverTx = this.clientsPersist[client.id].hoverTx;
        client.hoverRx = this.clientsPersist[client.id].hoverRx;

        return client;
      });

      if (this.enableSortClient) {
        this.clients = sortByProperty(this.clients, 'name', this.sortClient);
      }
    },
    login(e) {
      e.preventDefault();

      if (!this.password) return;
      if (this.authenticating) return;

      this.authenticating = true;
      this.api.createSession({
        password: this.password,
        remember: this.remember,
      })
        .then(async () => {
          const session = await this.api.getSession();
          this.authenticated = session.authenticated;
          this.requiresPassword = session.requiresPassword;
          await this.refresh();
          // loadTunnelInterfaces / loadSettings are called in mounted() but may
          // have got 401 (unauthenticated) before login. Re-load now that we have a session.
          this.loadTunnelInterfaces();
          this.loadSettings(); // needed for AWG2 template dropdown in Create/Edit modals
          if (this.activePage === 'gateways') {
            this.loadGateways();
            this.loadGatewayGroups();
            this.loadSystemInterfaces();
          }
        })
        .catch((err) => {
          alert(err.message || err.toString());
        })
        .finally(() => {
          this.authenticating = false;
          this.password = null;
        });
    },
    logout(e) {
      e.preventDefault();

      this.api.deleteSession()
        .then(() => {
          this.authenticated = false;
          this.clients = null;
        })
        .catch((err) => {
          alert(err.message || err.toString());
        });
    },
    createClient() {
      const name = this.clientCreateName;
      const expiredDate = this.clientExpiredDate;
      if (!name) return;

      this.api.createClient({ name, expiredDate })
        .catch((err) => alert(err.message || err.toString()))
        .finally(() => this.refresh().catch(console.error));
    },
    deleteClient(client) {
      this.api.deleteClient({ clientId: client.id })
        .catch((err) => alert(err.message || err.toString()))
        .finally(() => this.refresh().catch(console.error));
    },
    showOneTimeLink(client) {
      this.api.showOneTimeLink({ clientId: client.id })
        .catch((err) => alert(err.message || err.toString()))
        .finally(() => this.refresh().catch(console.error));
    },
    enableClient(client) {
      this.api.enableClient({ clientId: client.id })
        .catch((err) => alert(err.message || err.toString()))
        .finally(() => this.refresh().catch(console.error));
    },
    disableClient(client) {
      this.api.disableClient({ clientId: client.id })
        .catch((err) => alert(err.message || err.toString()))
        .finally(() => this.refresh().catch(console.error));
    },
    updateClientName(client, name) {
      this.api.updateClientName({ clientId: client.id, name })
        .catch((err) => alert(err.message || err.toString()))
        .finally(() => this.refresh().catch(console.error));
    },
    updateClientAddress(client, address) {
      this.api.updateClientAddress({ clientId: client.id, address })
        .catch((err) => alert(err.message || err.toString()))
        .finally(() => this.refresh().catch(console.error));
    },
    updateClientExpireDate(client, expireDate) {
      this.api.updateClientExpireDate({ clientId: client.id, expireDate })
        .catch((err) => alert(err.message || err.toString()))
        .finally(() => this.refresh().catch(console.error));
    },
    restoreConfig(e) {
      e.preventDefault();
      const file = e.currentTarget.files.item(0);
      if (file) {
        file.text()
          .then((content) => {
            this.api.restoreConfiguration(content)
              .then((_result) => alert('The configuration was updated.'))
              .catch((err) => alert(err.message || err.toString()))
              .finally(() => this.refresh().catch(console.error));
          })
          .catch((err) => alert(err.message || err.toString()));
      } else {
        alert('Failed to load your file!');
      }
    },
    toggleTheme() {
      const themes = ['light', 'dark', 'auto'];
      const currentIndex = themes.indexOf(this.uiTheme);
      const newIndex = (currentIndex + 1) % themes.length;
      this.uiTheme = themes[newIndex];
      localStorage.theme = this.uiTheme;
      this.setTheme(this.uiTheme);
    },
    setTheme(theme) {
      const { classList } = document.documentElement;
      const shouldAddDarkClass = theme === 'dark' || (theme === 'auto' && this.prefersDarkScheme.matches);
      classList.toggle('dark', shouldAddDarkClass);
    },
    handlePrefersChange(e) {
      if (localStorage.theme === 'auto') {
        this.setTheme(e.matches ? 'dark' : 'light');
      }
    },
    toggleCharts() {
      localStorage.setItem('uiShowCharts', this.uiShowCharts ? 1 : 0);
    },

    // Sidebar navigation
    switchPage(pageId) {
      this.activePage = pageId;
      if (pageId === 'interfaces') this.loadTunnelInterfaces();
      if (pageId === 'settings') this.loadSettings();
      if (pageId === 'gateways') {
        this.loadGateways();
        this.loadGatewayGroups();
        this.loadSystemInterfaces();
      }
      if (pageId === 'routing') {
        // Запускаем параллельно — loadKernelRoutes не зависит от списка таблиц
        // (routingTable по умолчанию 'main', всегда валидна)
        this.loadRoutingTables();
        this.loadKernelRoutes();
        this.loadStaticRoutes();
      }
    },

    // ========================================================================
    // Tunnel Interfaces Methods (New Architecture)
    // ========================================================================

    async loadTunnelInterfaces() {
      try {
        const res = await fetch('/api/tunnel-interfaces', { credentials: 'include' });
        if (!res.ok) throw new Error(res.statusText);
        const data = await res.json();
        this.tunnelInterfaces = data.interfaces || [];
      } catch (err) {
        console.error('Failed to load tunnel interfaces:', err);
      }
    },

    async createTunnelInterface() {
      try {
        if (!this.interfaceCreate.name) {
          alert('Please enter interface name');
          return;
        }

        // Tunnel Address обязателен — нужен для авто-IP пиров и PostUp/PostDown
        if (!this.interfaceCreate.address || !this.interfaceCreate.address.includes('/')) {
          alert('Please enter Tunnel Address in CIDR format (e.g. 10.100.0.1/24)');
          return;
        }

        if (this.interfaceCreate.protocol === 'amneziawg-2.0') {
          if (!this.interfaceCreate.settings.h1 || !this.interfaceCreate.settings.h2 ||
              !this.interfaceCreate.settings.h3 || !this.interfaceCreate.settings.h4) {
            alert('Please set H1-H4 parameters for AWG 2.0 (select a profile or enter manually)');
            return;
          }
        }

        const payload = {
          name: this.interfaceCreate.name,
          protocol: this.interfaceCreate.protocol,
          address: this.interfaceCreate.address,
          listenPort: this.interfaceCreate.listenPort ? parseInt(this.interfaceCreate.listenPort, 10) : undefined,
          disableRoutes: this.interfaceCreate.disableRoutes || false,
        };

        if (this.interfaceCreate.protocol === 'amneziawg-2.0') {
          payload.settings = this.interfaceCreate.settings;
        }

        const res = await fetch('/api/tunnel-interfaces', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const error = await res.json();
          throw new Error(error.message || res.statusText);
        }

        const newIface = await res.json();
        this.showInterfaceCreate = false;
        this.interfaceCreate = {
          name: '', protocol: 'wireguard-1.0', address: '', listenPort: '', disableRoutes: false,
          selectedTemplateId: '',
          settings: { jc: 6, jmin: 10, jmax: 50, s1: 64, s2: 67, s3: 64, s4: 4, h1: '', h2: '', h3: '', h4: '', i1: '', i2: '', i3: '', i4: '', i5: '' },
        };

        await this.loadTunnelInterfaces();
        // Auto-switch to the new interface tab
        if (newIface && newIface.id) {
          this.activeInterfaceId = newIface.id;
        }
      } catch (err) {
        console.error('Failed to create interface:', err);
        alert(`Failed: ${err.message}`);
      }
    },

    // ========================================================================
    // Edit Interface
    // ========================================================================

    openInterfaceEdit(iface) {
      const s = iface.settings || {};
      this.interfaceEdit = {
        id: iface.id,
        name: iface.name || iface.id,
        address: iface.address || '',
        listenPort: iface.listenPort || '',
        disableRoutes: !!iface.disableRoutes,
        protocol: iface.protocol || 'wireguard-1.0',
        selectedTemplateId: '',
        settings: {
          jc:   s.jc   ?? 6,   jmin: s.jmin ?? 10,  jmax: s.jmax ?? 50,
          s1:   s.s1   ?? 64,  s2:   s.s2   ?? 67,  s3:   s.s3  ?? 64,  s4: s.s4 ?? 4,
          h1:   s.h1   || '',  h2:   s.h2   || '',  h3:   s.h3  || '',  h4: s.h4 || '',
          i1:   s.i1   || '',  i2:   s.i2   || '',  i3:   s.i3  || '',  i4: s.i4 || '',  i5: s.i5 || '',
        },
      };
      this.showInterfaceEdit = true;
    },

    onEditInterfaceTemplateSelect(templateId) {
      if (!templateId) return;
      const tmpl = (this.templates || []).find(t => t.id === templateId);
      if (!tmpl) return;
      this.interfaceEdit.settings = {
        jc:   tmpl.jc,   jmin: tmpl.jmin,  jmax: tmpl.jmax,
        s1:   tmpl.s1,   s2:   tmpl.s2,    s3:   tmpl.s3,   s4: tmpl.s4,
        h1:   tmpl.h1,   h2:   tmpl.h2,    h3:   tmpl.h3,   h4: tmpl.h4,
        i1:   tmpl.i1 || '', i2: tmpl.i2 || '', i3: tmpl.i3 || '',
        i4:   tmpl.i4 || '', i5: tmpl.i5 || '',
      };
    },

    async saveInterfaceEdit() {
      const { id, name, address, listenPort, disableRoutes, protocol, settings } = this.interfaceEdit;

      if (!name) { alert('Please enter a name'); return; }
      if (!address || !address.includes('/')) {
        alert('Please enter Tunnel Address in CIDR format (e.g. 10.100.0.1/24)');
        return;
      }
      if (protocol === 'amneziawg-2.0') {
        if (!settings.h1 || !settings.h2 || !settings.h3 || !settings.h4) {
          alert('Please set H1-H4 parameters for AWG 2.0 (select a profile or enter manually)');
          return;
        }
      }

      const payload = {
        name,
        address,
        listenPort: listenPort !== '' && listenPort !== null ? Number(listenPort) : undefined,
        disableRoutes,
      };
      if (protocol === 'amneziawg-2.0') {
        payload.settings = { ...settings };
      }

      try {
        const res = await this.api.updateTunnelInterface({ interfaceId: id, ...payload });
        this._applyInterfaceUpdate(res.interface);
        this.showInterfaceEdit = false;
      } catch (err) {
        console.error('saveInterfaceEdit failed:', err);
        alert(`Failed: ${err.message}`);
      }
    },

    async deleteTunnelInterface(iface) {
      if (!confirm(`Delete interface "${iface.name}"? This will also delete all peers.`)) return;
      try {
        const res = await fetch(`/api/tunnel-interfaces/${iface.id}`, {
          method: 'DELETE',
          credentials: 'include',
        });
        if (!res.ok) throw new Error(res.statusText);
        if (this.activeInterfaceId === iface.id) {
          this.activeInterfaceId = null;
          this.selectedInterface = null;
          this.selectedInterfacePeers = [];
        }
        await this.loadTunnelInterfaces();
      } catch (err) {
        console.error('Delete failed:', err);
        alert(`Failed: ${err.message}`);
      }
    },

    // Обновить один интерфейс в массиве реактивно (Vue 2 splice).
    // Вызывается после start/stop/restart — данные берём из ответа API,
    // чтобы не делать лишний GET и не зависеть от состояния сети.
    _applyInterfaceUpdate(updatedIface) {
      const idx = this.tunnelInterfaces.findIndex(i => i.id === updatedIface.id);
      if (idx !== -1) {
        this.tunnelInterfaces.splice(idx, 1, updatedIface);
      } else {
        // Интерфейс появился впервые (например после create + immediate start)
        this.tunnelInterfaces.push(updatedIface);
      }
    },

    async startTunnelInterface(iface) {
      if (this.loadingInterfaceId) return; // предотвратить двойной клик
      this.loadingInterfaceId = iface.id;
      try {
        const res = await fetch(`/api/tunnel-interfaces/${iface.id}/start`, {
          method: 'POST',
          credentials: 'include',
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.message || res.statusText);
        }
        const data = await res.json();
        if (data.interface) this._applyInterfaceUpdate(data.interface);
      } catch (err) {
        console.error('Start failed:', err);
        alert(`Start failed: ${err.message}`);
      } finally {
        this.loadingInterfaceId = null;
      }
    },

    async stopTunnelInterface(iface) {
      if (this.loadingInterfaceId) return;
      this.loadingInterfaceId = iface.id;
      try {
        const res = await fetch(`/api/tunnel-interfaces/${iface.id}/stop`, {
          method: 'POST',
          credentials: 'include',
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.message || res.statusText);
        }
        const data = await res.json();
        if (data.interface) this._applyInterfaceUpdate(data.interface);
      } catch (err) {
        console.error('Stop failed:', err);
        alert(`Stop failed: ${err.message}`);
      } finally {
        this.loadingInterfaceId = null;
      }
    },

    async restartTunnelInterface(iface) {
      if (this.loadingInterfaceId) return;
      this.loadingInterfaceId = iface.id;
      try {
        const res = await fetch(`/api/tunnel-interfaces/${iface.id}/restart`, {
          method: 'POST',
          credentials: 'include',
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.message || res.statusText);
        }
        const data = await res.json();
        if (data.interface) this._applyInterfaceUpdate(data.interface);
      } catch (err) {
        console.error('Restart failed:', err);
        alert(`Restart failed: ${err.message}`);
      } finally {
        this.loadingInterfaceId = null;
      }
    },

    async loadInterfacePeers(interfaceId) {
      try {
        const res = await fetch(`/api/tunnel-interfaces/${interfaceId}/peers`, { credentials: 'include' });
        if (!res.ok) throw new Error(res.statusText);
        const data = await res.json();
        this.selectedInterfacePeers = data.peers || [];
      } catch (err) {
        console.error('Failed to load peers:', err);
        this.selectedInterfacePeers = [];
      }
    },

    async createPeer() {
      if (!this.activeInterfaceId) {
        alert('No interface selected');
        return;
      }

      const { mode, peerType, name, publicKey, endpoint, allowedIPs, clientAllowedIPs, persistentKeepalive } = this.peerCreate;

      // Validation
      if (!name || name.trim() === '') {
        alert('Please enter a peer name');
        return;
      }
      if (mode === 'manual' && !publicKey) {
        alert('Please enter the public key');
        return;
      }
      // Interconnect requires explicit AllowedIPs (it routes a subnet, not just /32)
      if (peerType === 'interconnect' && !allowedIPs) {
        alert('Please enter Allowed IPs for the interconnect peer (e.g., 192.168.2.0/24)');
        return;
      }

      // For client+generate with no allowedIPs → auto-allocate /32 from interface subnet
      const autoAllocate = mode === 'generate' && peerType === 'client' && !allowedIPs;

      const payload = {
        name,
        peerType,
        ...(mode === 'generate' ? { generateKeys: true } : { publicKey }),
        ...(autoAllocate ? { autoAllocateIP: true } : { allowedIPs }),
        clientAllowedIPs: clientAllowedIPs || undefined,
        endpoint: endpoint || undefined,
        persistentKeepalive: persistentKeepalive || 25,
      };

      try {
        const res = await this.api.createTunnelInterfacePeer({
          interfaceId: this.activeInterfaceId,
          ...payload,
        });

        const interfaceId = this.activeInterfaceId;
        const peerId = res.peer && res.peer.id;

        this.showPeerCreate = false;
        this.peerCreate = { mode: 'generate', peerType: 'client', name: '', publicKey: '', endpoint: '', allowedIPs: '', clientAllowedIPs: '', persistentKeepalive: 25 };

        await this.refreshPeers();
        await this.loadTunnelInterfaces();

        // Show QR immediately for client peers with server-generated keys
        if (mode === 'generate' && peerType === 'client' && peerId) {
          this.qrcode = `./api/tunnel-interfaces/${interfaceId}/peers/${peerId}/qrcode.svg`;
        } else {
          alert('Peer created!');
        }
      } catch (err) {
        console.error('Failed to create peer:', err);
        alert(`Failed: ${err.message}`);
      }
    },

    async deletePeer(peer) {
      if (!confirm(`Delete peer "${peer.name}"?`)) return;
      try {
        const res = await fetch(`/api/tunnel-interfaces/${this.selectedInterface.id}/peers/${peer.id}`, {
          method: 'DELETE',
          credentials: 'include',
        });
        if (!res.ok) throw new Error(res.statusText);
        await this.loadInterfacePeers(this.selectedInterface.id);
        await this.loadTunnelInterfaces();
        alert('Peer deleted!');
      } catch (err) {
        console.error('Delete failed:', err);
        alert(`Failed: ${err.message}`);
      }
    },

    async downloadPeerConfig(peer) {
      try {
        const res = await fetch(`/api/tunnel-interfaces/${this._peerIfaceId(peer)}/peers/${peer.id}/config`, {
          credentials: 'include',
        });
        if (!res.ok) throw new Error(res.statusText);
        const config = await res.text();
        const blob = new Blob([config], { type: 'text/plain' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${peer.name.replace(/\s+/g, '-')}.conf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
      } catch (err) {
        console.error('Download failed:', err);
        alert(`Failed: ${err.message}`);
      }
    },

    // ========================================================================
    // Gateways Methods
    // ========================================================================

    async loadGateways() {
      try {
        const res = await this.api.getGateways();
        this.gateways = res.gateways || [];
      } catch (err) {
        console.error('loadGateways error:', err);
      }
    },

    async refreshGateways() {
      try {
        const res = await this.api.getGateways();
        this.gateways = res.gateways || [];
      } catch (_) { /* silent poll */ }
    },

    async loadGatewayGroups() {
      try {
        const res = await this.api.getGatewayGroups();
        this.gatewayGroups = res.groups || [];
      } catch (err) {
        console.error('loadGatewayGroups error:', err);
      }
    },

    async loadSystemInterfaces() {
      try {
        const res = await this.api.getSystemInterfaces();
        this.systemInterfaces = res.interfaces || [];
      } catch (err) {
        console.error('loadSystemInterfaces error:', err);
      }
    },

    // ── Create Gateway ────────────────────────────────────────────────────────
    async createGateway() {
      const f = this.gatewayCreate;
      if (!f.name.trim())      return alert('Gateway name is required');
      if (!f.interface)        return alert('Interface is required');
      if (!f.gatewayIP.trim()) return alert('Gateway IP is required');
      try {
        await this.api.createGateway({
          name:             f.name.trim(),
          interface:        f.interface,
          gatewayIP:        f.gatewayIP.trim(),
          monitorAddress:   f.monitorAddress.trim(),
          monitor:          f.monitor,
          monitorInterval:  Number(f.monitorInterval),
          windowSeconds:    f.windowSeconds !== null ? Number(f.windowSeconds) : null,
          latencyThreshold: Number(f.latencyThreshold),
          description:      f.description.trim(),
        });
        this.showGatewayCreate = false;
        this.gatewayCreate = {
          name: '', interface: '', gatewayIP: '', monitorAddress: '',
          monitor: true, monitorInterval: 5, windowSeconds: null,
          latencyThreshold: 500, description: '',
        };
        await this.loadGateways();
      } catch (err) {
        alert(`Failed: ${err.message}`);
      }
    },

    // ── Edit Gateway ──────────────────────────────────────────────────────────
    openGatewayEdit(gw) {
      this.gatewayEdit = {
        id:               gw.id,
        name:             gw.name,
        interface:        gw.interface,
        gatewayIP:        gw.gatewayIP || '',
        monitorAddress:   gw.monitorAddress || '',
        monitor:          gw.monitor,
        monitorInterval:  gw.monitorInterval,
        windowSeconds:    gw.windowSeconds ?? null,
        latencyThreshold: gw.latencyThreshold || 500,
        description:      gw.description || '',
      };
      this.showGatewayEdit = true;
    },

    async saveGatewayEdit() {
      const f = this.gatewayEdit;
      if (!f.name.trim())      return alert('Gateway name is required');
      if (!f.interface)        return alert('Interface is required');
      if (!f.gatewayIP.trim()) return alert('Gateway IP is required');
      try {
        await this.api.updateGateway({
          gatewayId:        f.id,
          name:             f.name.trim(),
          interface:        f.interface,
          gatewayIP:        f.gatewayIP.trim(),
          monitorAddress:   f.monitorAddress.trim(),
          monitor:          f.monitor,
          monitorInterval:  Number(f.monitorInterval),
          windowSeconds:    f.windowSeconds !== null ? Number(f.windowSeconds) : null,
          latencyThreshold: Number(f.latencyThreshold),
          description:      f.description.trim(),
        });
        this.showGatewayEdit = false;
        const res = await this.api.getGateways();
        this.gateways = res.gateways || [];
      } catch (err) {
        alert(`Failed: ${err.message}`);
      }
    },

    // ── Delete Gateway ────────────────────────────────────────────────────────
    async deleteGateway(gw) {
      if (!confirm(`Delete gateway "${gw.name}"?`)) return;
      try {
        await this.api.deleteGateway({ gatewayId: gw.id });
        const res = await this.api.getGateways();
        this.gateways = res.gateways || [];
      } catch (err) {
        alert(`Failed: ${err.message}`);
      }
    },

    // ── Create Gateway Group ──────────────────────────────────────────────────
    async createGatewayGroup() {
      const f = this.groupCreate;
      if (!f.name.trim()) return alert('Group name is required');
      try {
        await this.api.createGatewayGroup({
          name:        f.name.trim(),
          trigger:     f.trigger,
          description: f.description.trim(),
          gateways:    f.gateways,
        });
        this.showGroupCreate = false;
        this.groupCreate = { name: '', trigger: 'packetloss', description: '', gateways: [] };
        await this.loadGatewayGroups();
      } catch (err) {
        alert(`Failed: ${err.message}`);
      }
    },

    // ── Edit Gateway Group ────────────────────────────────────────────────────
    openGroupEdit(grp) {
      this.groupEdit = {
        id:          grp.id,
        name:        grp.name,
        trigger:     grp.trigger,
        description: grp.description || '',
        gateways:    JSON.parse(JSON.stringify(grp.gateways || [])),
      };
      this.showGroupEdit = true;
    },

    async saveGroupEdit() {
      const f = this.groupEdit;
      if (!f.name.trim()) return alert('Group name is required');
      try {
        await this.api.updateGatewayGroup({
          groupId:     f.id,
          name:        f.name.trim(),
          trigger:     f.trigger,
          description: f.description.trim(),
          gateways:    f.gateways,
        });
        this.showGroupEdit = false;
        const res = await this.api.getGatewayGroups();
        this.gatewayGroups = res.groups || [];
      } catch (err) {
        alert(`Failed: ${err.message}`);
      }
    },

    // ── Delete Gateway Group ──────────────────────────────────────────────────
    async deleteGatewayGroup(grp) {
      if (!confirm(`Delete gateway group "${grp.name}"?`)) return;
      try {
        await this.api.deleteGatewayGroup({ groupId: grp.id });
        const res = await this.api.getGatewayGroups();
        this.gatewayGroups = res.groups || [];
      } catch (err) {
        alert(`Failed: ${err.message}`);
      }
    },

    // ── Group gateways entry helpers ──────────────────────────────────────────
    addGroupGatewayEntry(form) {
      form.gateways.push({ gatewayId: '', tier: 1, weight: 100 });
    },

    removeGroupGatewayEntry(form, idx) {
      form.gateways.splice(idx, 1);
    },

    // ── Status helpers ────────────────────────────────────────────────────────
    gatewayStatusColor(status) {
      const map = { healthy: '#22c55e', degraded: '#eab308', down: '#ef4444', unknown: '#9ca3af' };
      return map[status] || map.unknown;
    },

    gatewayStatusLabel(status) {
      const map = { healthy: 'Healthy', degraded: 'Degraded', down: 'Down', unknown: 'Unknown' };
      return map[status] || 'Unknown';
    },

    // Look up gateway name by id (used in group display)
    gatewayNameById(id) {
      const gw = this.gateways.find(g => g.id === id);
      return gw ? gw.name : id;
    },

    gatewayStatusById(id) {
      const gw = this.gateways.find(g => g.id === id);
      return gw ? gw.status : 'unknown';
    },

    // ========================================================================
    // Routing Methods
    // ========================================================================

    switchRoutingTab(tab) {
      this.activeRoutingTab = tab;
      if (tab === 'status') this.loadKernelRoutes();
    },

    async loadRoutingTables() {
      try {
        const res = await this.api.getRoutingTables();
        this.routingTables = res.tables || [];
        // Установить дефолтную таблицу = 'main' если она есть
        if (this.routingTables.length > 0 && !this.routingTables.find(t => t.name === this.routingTable)) {
          this.routingTable = this.routingTables[0].name;
        }
      } catch (err) {
        console.error('loadRoutingTables error:', err);
        this.routingTables = [{ id: 254, name: 'main' }, { id: null, name: 'all' }];
      }
    },

    async loadKernelRoutes() {
      this.kernelRoutesError = '';
      this.kernelRoutesLoading = true;
      try {
        const res = await this.api.getKernelRoutes(this.routingTable);
        this.kernelRoutes = res.routes || [];
      } catch (err) {
        console.error('loadKernelRoutes error:', err);
        this.kernelRoutesError = err.message || 'Failed to load kernel routes';
        this.kernelRoutes = [];
      } finally {
        this.kernelRoutesLoading = false;
      }
    },

    async loadStaticRoutes() {
      try {
        const res = await this.api.getStaticRoutes();
        this.staticRoutes = res.routes || [];
      } catch (err) {
        console.error('loadStaticRoutes error:', err);
      }
    },

    async testRoute() {
      if (!this.routeTestIp) return;
      this.routeTestLoading = true;
      this.routeTestResult = null;
      this.routeTestError = '';
      try {
        const res = await this.api.testRoute(this.routeTestIp);
        this.routeTestResult = res.result;
      } catch (err) {
        this.routeTestError = err.message || 'Error';
      } finally {
        this.routeTestLoading = false;
      }
    },

    async createRoute() {
      try {
        const data = {
          description: this.routeCreate.description,
          destination: this.routeCreate.destination,
          gateway: this.routeCreate.gateway,
          dev: this.routeCreate.dev,
          metric: this.routeCreate.metric !== '' ? Number(this.routeCreate.metric) : null,
          table: this.routeCreate.table || 'main',
        };
        await this.api.createStaticRoute(data);
        this.showRouteCreate = false;
        this.routeCreate = { description: '', destination: '', gateway: '', dev: '', metric: '', table: 'main' };
        await this.loadStaticRoutes();
      } catch (err) {
        alert(err.message || 'Failed to create route');
      }
    },

    async toggleRoute(id, enabled) {
      try {
        await this.api.toggleStaticRoute({ routeId: id, enabled });
        await this.loadStaticRoutes();
      } catch (err) {
        alert(err.message || 'Failed to toggle route');
      }
    },

    async deleteRoute(id) {
      if (!confirm('Delete this route?')) return;
      try {
        await this.api.deleteStaticRoute({ routeId: id });
        await this.loadStaticRoutes();
      } catch (err) {
        alert(err.message || 'Failed to delete route');
      }
    },

    // ========================================================================
    // Quick peer create (one-click, admin-tunnel style)
    // ========================================================================

    async createQuickPeer() {
      if (!this.activeInterfaceId) return;
      const name = this.peerCreateName;
      if (!name) return;

      try {
        const payload = {
          name,
          autoAllocateIP: true,
          generateKeys: true,
          expiredDate: this.peerCreateExpiredDate || undefined,
        };

        const res = await this.api.createTunnelInterfacePeer({
          interfaceId: this.activeInterfaceId,
          ...payload,
        });

        const peerId = res.peer && res.peer.id;
        this.showQuickPeerCreate = false;
        this.peerCreateName = '';
        this.peerCreateExpiredDate = '';

        await this.refreshPeers();
        await this.loadTunnelInterfaces();

        // Show QR immediately
        if (peerId) {
          this.qrcode = `./api/tunnel-interfaces/${this.activeInterfaceId}/peers/${peerId}/qrcode.svg`;
        }
      } catch (err) {
        console.error('Failed to create peer:', err);
        alert(`Failed: ${err.message}`);
      }
    },

    // ========================================================================
    // Peer management methods (admin-tunnel style)
    // ========================================================================

    // Returns the correct interfaceId for a peer action, works both in per-interface view and dashboard
    _peerIfaceId(peer) {
      return (peer && peer.interfaceId) || this.activeInterfaceId;
    },

    // Refresh peers: if an interface tab is selected, refresh that interface; otherwise refresh all (dashboard)
    async _refreshPeersOrAll(opts = {}) {
      if (this.activeInterfaceId) {
        await this.refreshPeers(opts);
      } else {
        await this.refreshAllPeers(opts);
      }
    },

    async enablePeer(peer) {
      try {
        await this.api.enablePeer({ interfaceId: this._peerIfaceId(peer), peerId: peer.id });
        await this._refreshPeersOrAll();
      } catch (err) {
        alert(err.message || err.toString());
      }
    },

    async disablePeer(peer) {
      try {
        await this.api.disablePeer({ interfaceId: this._peerIfaceId(peer), peerId: peer.id });
        await this._refreshPeersOrAll();
      } catch (err) {
        alert(err.message || err.toString());
      }
    },

    async updatePeerName(peer, name) {
      try {
        await this.api.updatePeerName({ interfaceId: this._peerIfaceId(peer), peerId: peer.id, name });
        await this._refreshPeersOrAll();
      } catch (err) {
        alert(err.message || err.toString());
      }
    },

    async updatePeerAddress(peer, address) {
      try {
        await this.api.updatePeerAddress({ interfaceId: this._peerIfaceId(peer), peerId: peer.id, address });
        await this._refreshPeersOrAll();
      } catch (err) {
        alert(err.message || err.toString());
      }
    },

    async updatePeerExpireDate(peer, expireDate) {
      try {
        await this.api.updatePeerExpireDate({ interfaceId: this._peerIfaceId(peer), peerId: peer.id, expireDate });
        await this._refreshPeersOrAll();
      } catch (err) {
        alert(err.message || err.toString());
      }
    },

    async showPeerOneTimeLink(peer) {
      try {
        await this.api.generatePeerOneTimeLink({ interfaceId: this._peerIfaceId(peer), peerId: peer.id });
        await this._refreshPeersOrAll();
      } catch (err) {
        alert(err.message || err.toString());
      }
    },

    async confirmDeletePeer() {
      if (!this.peerDelete) return;
      try {
        await this.api.deleteTunnelInterfacePeer({
          interfaceId: this._peerIfaceId(this.peerDelete),
          peerId: this.peerDelete.id,
        });
        this.peerDelete = null;
        await this._refreshPeersOrAll();
        await this.loadTunnelInterfaces();
      } catch (err) {
        alert(err.message || err.toString());
      }
    },

    /**
     * Refresh peers with transfer stats (called periodically like admin tunnel's refresh()).
     */
    async refreshPeers({ updateCharts = false } = {}) {
      if (!this.authenticated || !this.activeInterfaceId) return;

      try {
        const res = await this.api.getTunnelInterfacePeers({ interfaceId: this.activeInterfaceId });
        const peers = (res.peers || []).map(peer => {
          // Tag with interfaceId so actions work from dashboard too
          peer.interfaceId = this.activeInterfaceId;

          // Parse dates
          peer.createdAt = peer.createdAt ? new Date(peer.createdAt) : null;
          peer.updatedAt = peer.updatedAt ? new Date(peer.updatedAt) : null;
          peer.expiredAt = peer.expiredAt ? new Date(peer.expiredAt) : null;
          peer.latestHandshakeAt = peer.latestHandshakeAt ? new Date(peer.latestHandshakeAt) : null;

          // Avatar
          if (peer.name && this.avatarSettings.dicebear) {
            peer.avatar = `https://api.dicebear.com/9.x/${this.avatarSettings.dicebear}/svg?seed=${sha256(peer.name.toLowerCase().trim())}`;
          }

          // Transfer stats persistence (delta calculation for charts)
          if (!this.peersPersist[peer.id]) {
            this.peersPersist[peer.id] = {};
            this.peersPersist[peer.id].transferRxHistory = Array(50).fill(0);
            this.peersPersist[peer.id].transferRxPrevious = peer.transferRx || 0;
            this.peersPersist[peer.id].transferTxHistory = Array(50).fill(0);
            this.peersPersist[peer.id].transferTxPrevious = peer.transferTx || 0;
          }

          const pp = this.peersPersist[peer.id];
          pp.transferRxCurrent = (peer.transferRx || 0) - pp.transferRxPrevious;
          pp.transferRxPrevious = peer.transferRx || 0;
          pp.transferTxCurrent = (peer.transferTx || 0) - pp.transferTxPrevious;
          pp.transferTxPrevious = peer.transferTx || 0;

          if (updateCharts) {
            pp.transferRxHistory.push(pp.transferRxCurrent);
            pp.transferRxHistory.shift();
            pp.transferTxHistory.push(pp.transferTxCurrent);
            pp.transferTxHistory.shift();

            pp.transferTxSeries = [{ name: 'Tx', data: pp.transferTxHistory }];
            pp.transferRxSeries = [{ name: 'Rx', data: pp.transferRxHistory }];

            peer.transferTxHistory = pp.transferTxHistory;
            peer.transferRxHistory = pp.transferRxHistory;
            peer.transferMax = Math.max(...peer.transferTxHistory, ...peer.transferRxHistory);
            peer.transferTxSeries = pp.transferTxSeries;
            peer.transferRxSeries = pp.transferRxSeries;
          }

          peer.transferTxCurrent = pp.transferTxCurrent;
          peer.transferRxCurrent = pp.transferRxCurrent;
          peer.hoverTx = pp.hoverTx;
          peer.hoverRx = pp.hoverRx;

          return peer;
        });

        this.selectedInterfacePeers = peers;
      } catch (err) {
        console.error('refreshPeers failed:', err);
      }
    },

    /**
     * Dashboard mode: load peers from ALL interfaces into this.allPeers.
     * Each peer gets peer.interfaceId and peer.interfaceName set.
     */
    async refreshAllPeers({ updateCharts = false } = {}) {
      if (!this.authenticated) return;
      const all = [];
      for (const iface of this.tunnelInterfaces) {
        try {
          const res = await this.api.getTunnelInterfacePeers({ interfaceId: iface.id });
          const peers = (res.peers || []).map(peer => {
            peer.interfaceId   = iface.id;
            peer.interfaceName = iface.name || iface.id;

            peer.createdAt = peer.createdAt ? new Date(peer.createdAt) : null;
            peer.updatedAt = peer.updatedAt ? new Date(peer.updatedAt) : null;
            peer.expiredAt = peer.expiredAt ? new Date(peer.expiredAt) : null;
            peer.latestHandshakeAt = peer.latestHandshakeAt ? new Date(peer.latestHandshakeAt) : null;

            if (peer.name && this.avatarSettings.dicebear) {
              peer.avatar = `https://api.dicebear.com/9.x/${this.avatarSettings.dicebear}/svg?seed=${sha256(peer.name.toLowerCase().trim())}`;
            }

            if (!this.peersPersist[peer.id]) {
              this.peersPersist[peer.id] = {};
              this.peersPersist[peer.id].transferRxHistory  = Array(50).fill(0);
              this.peersPersist[peer.id].transferRxPrevious = peer.transferRx || 0;
              this.peersPersist[peer.id].transferTxHistory  = Array(50).fill(0);
              this.peersPersist[peer.id].transferTxPrevious = peer.transferTx || 0;
            }
            const pp = this.peersPersist[peer.id];
            pp.transferRxCurrent = (peer.transferRx || 0) - pp.transferRxPrevious;
            pp.transferRxPrevious = peer.transferRx || 0;
            pp.transferTxCurrent = (peer.transferTx || 0) - pp.transferTxPrevious;
            pp.transferTxPrevious = peer.transferTx || 0;

            if (updateCharts) {
              pp.transferRxHistory.push(pp.transferRxCurrent);
              pp.transferRxHistory.shift();
              pp.transferTxHistory.push(pp.transferTxCurrent);
              pp.transferTxHistory.shift();
              pp.transferTxSeries = [{ name: 'Tx', data: pp.transferTxHistory }];
              pp.transferRxSeries = [{ name: 'Rx', data: pp.transferRxHistory }];
              peer.transferTxHistory = pp.transferTxHistory;
              peer.transferRxHistory = pp.transferRxHistory;
              peer.transferMax       = Math.max(...peer.transferTxHistory, ...peer.transferRxHistory);
              peer.transferTxSeries  = pp.transferTxSeries;
              peer.transferRxSeries  = pp.transferRxSeries;
            }
            peer.transferTxCurrent = pp.transferTxCurrent;
            peer.transferRxCurrent = pp.transferRxCurrent;
            peer.hoverTx = pp.hoverTx;
            peer.hoverRx = pp.hoverRx;

            return peer;
          });
          all.push(...peers);
        } catch (err) {
          // skip failed interface silently
        }
      }
      this.allPeers = all;
    },

    async backupInterface() {
      if (!this.activeInterfaceId) return;
      try {
        const data = await this.api.backupTunnelInterface({ interfaceId: this.activeInterfaceId });
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${this.activeInterfaceId}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
      } catch (err) {
        alert(`Backup failed: ${err.message}`);
      }
    },

    restoreInterface(e) {
      if (!this.activeInterfaceId) return;
      const fileInput = e.currentTarget.files.item(0);
      if (!fileInput) return;
      fileInput.text()
        .then((content) => {
          const file = JSON.parse(content);
          return this.api.restoreTunnelInterface({ interfaceId: this.activeInterfaceId, file });
        })
        .then(() => {
          alert('Configuration restored!');
          this.refreshPeers();
          this.loadTunnelInterfaces();
        })
        .catch((err) => alert(`Restore failed: ${err.message}`));
    },

    // ============================================================
    // Interconnect Export / Import
    // ============================================================

    /**
     * Export THIS interface's parameters as JSON for the remote side to import.
     *
     * Workflow: this side clicks "Export My Params" → sends file to remote side →
     * remote side clicks "Import JSON" → peer for us is created automatically.
     *
     * File contains: name, publicKey, endpoint, address, protocol, AWG2 settings.
     * Remote side derives AllowedIPs subnet from our address (10.x.x.1/24 → 10.x.x.0/24).
     */
    async exportMyInterfaceParams(iface) {
      try {
        const params = await this.api.exportInterfaceParams({ interfaceId: iface.id });
        const blob = new Blob([JSON.stringify(params, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${iface.id}-params.json`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        alert(`Failed to export interface params: ${err.message}`);
      }
    },

    /**
     * Import remote side's interface params → create an interconnect peer for them.
     *
     * Workflow: remote side sends their export file → we click "Import JSON" →
     * peer is created automatically with their publicKey, endpoint, and derived AllowedIPs.
     */
    importInterconnectPeerJSON() {
      if (!this.activeInterfaceId) return;
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const text = await file.text();
          const data = JSON.parse(text);
          const res = await this.api.importPeerJSON({ interfaceId: this.activeInterfaceId, ...data });
          await this.refreshPeers();
          await this.loadTunnelInterfaces();

          // Если PSK был в файле — он уже согласован. Если мы его сгенерили —
          // нужно передать его другой стороне через Export My Params.
          const pskWasInFile = !!data.presharedKey;
          if (pskWasInFile) {
            alert('Peer imported! PSK taken from the file — both sides are in sync.\nThe tunnel should come up after both sides complete the exchange.');
          } else {
            alert('Peer imported! A PresharedKey was generated for this connection.\nNext step: click "Export My Params" and send the file to the remote side — it will include the PSK so they can use it when they Import JSON.');
          }
        } catch (err) {
          alert(`Failed to import peer: ${err.message}`);
        }
      };
      input.click();
    },

    async toggleDisableRoutes(iface) {
      try {
        await this.api.updateTunnelInterface({
          interfaceId: iface.id,
          disableRoutes: !iface.disableRoutes,
        });
        await this.loadTunnelInterfaces();
      } catch (err) {
        alert(`Failed: ${err.message}`);
      }
    },

    // ============================================================
    // Settings & Templates
    // ============================================================

    async loadSettings() {
      try {
        this.globalSettings = await this.api.getSettings();
        const { templates } = await this.api.getTemplates();
        this.templates = templates;
      } catch (err) {
        console.error('loadSettings failed:', err);
      }
    },

    async saveSettings() {
      try {
        await this.api.updateSettings(this.globalSettings);
        this.settingsSaved = true;
        setTimeout(() => { this.settingsSaved = false; }, 2500);
      } catch (err) {
        alert(`Failed to save settings: ${err.message}`);
      }
    },

    // H1-H4: non-overlapping random ranges in the uint32 space.
    // 4 equal zones, each gets a ~50 M wide sub-range.
    randomiseTemplateH() {
      const RANGE_SIZE = 50_000_000;
      const ZONE_SIZE = Math.floor((0xFFFFFFFF - 5) / 4);
      const r = (zone) => {
        const zs = 5 + zone * ZONE_SIZE;
        const ze = zs + ZONE_SIZE - 1;
        const start = zs + Math.floor(Math.random() * (ze - zs - RANGE_SIZE));
        return `${start}-${start + RANGE_SIZE}`;
      };
      this.templateForm.h1 = r(0);
      this.templateForm.h2 = r(1);
      this.templateForm.h3 = r(2);
      this.templateForm.h4 = r(3);
    },

    openTemplateCreate() {
      this.templateForm = {
        name: '',
        isDefault: false,
        jc: 6, jmin: 10, jmax: 50,
        s1: 64, s2: 67, s3: 64, s4: 4,
        h1: '', h2: '', h3: '', h4: '',
        i1: '', i2: '', i3: '', i4: '', i5: '',
      };
      this.randomiseTemplateH();
      this.templateEditTarget = null;
      this.showTemplateModal = true;
    },

    openTemplateEdit(tmpl) {
      this.templateForm = { ...tmpl };
      this.templateEditTarget = tmpl;
      this.showTemplateModal = true;
    },

    async saveTemplate() {
      try {
        if (this.templateEditTarget) {
          await this.api.updateTemplate({ templateId: this.templateEditTarget.id, ...this.templateForm });
        } else {
          await this.api.createTemplate(this.templateForm);
        }
        this.showTemplateModal = false;
        await this.loadSettings();
      } catch (err) {
        alert(`Failed to save template: ${err.message}`);
      }
    },

    async setDefaultTemplate(templateId) {
      try {
        await this.api.setDefaultTemplate({ templateId });
        await this.loadSettings();
      } catch (err) {
        alert(`Failed: ${err.message}`);
      }
    },

    async deleteTemplate(templateId) {
      if (!confirm('Delete this template?')) return;
      try {
        await this.api.deleteTemplate({ templateId });
        await this.loadSettings();
      } catch (err) {
        alert(`Failed to delete template: ${err.message}`);
      }
    },

    /**
     * Экспортировать профиль обфускации в JSON файл.
     * Скачивает файл с AWG2 параметрами шаблона.
     * Формат: { name, jc, jmin, jmax, s1-s4, h1-h4, i1-i5 }.
     * Поля meta (id, isDefault, createdAt) не включаются — они специфичны для этого сервера.
     */
    exportTemplateJSON(tmpl) {
      const params = {
        name: tmpl.name,
        jc: tmpl.jc, jmin: tmpl.jmin, jmax: tmpl.jmax,
        s1: tmpl.s1, s2: tmpl.s2, s3: tmpl.s3, s4: tmpl.s4,
        h1: tmpl.h1, h2: tmpl.h2, h3: tmpl.h3, h4: tmpl.h4,
        i1: tmpl.i1 || null, i2: tmpl.i2 || null, i3: tmpl.i3 || null,
        i4: tmpl.i4 || null, i5: tmpl.i5 || null,
      };
      const blob = new Blob([JSON.stringify(params, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `awg2-profile-${tmpl.name.replace(/[^a-zA-Z0-9_-]/g, '-')}.json`;
      a.click();
      URL.revokeObjectURL(url);
    },

    /**
     * Импортировать профиль обфускации из JSON файла.
     * Открывает выбор файла → читает JSON → создаёт новый шаблон через API.
     * Если в JSON нет поля name — запрашивает имя у пользователя.
     * Формат файла должен содержать AWG2 параметры (jc, jmin, ..., h1-h4).
     */
    importTemplateJSON() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const text = await file.text();
          const data = JSON.parse(text);
          // Если имени нет в файле — просим пользователя
          if (!data.name) {
            const name = prompt('Enter a name for this profile:', file.name.replace(/\.json$/i, ''));
            if (!name) return;
            data.name = name;
          }
          await this.api.createTemplate(data);
          await this.loadSettings();
        } catch (err) {
          alert(`Failed to import profile: ${err.message}`);
        }
      };
      input.click();
    },

    /**
     * Заполнить AWG2 поля формы из выбранного шаблона профиля обфускации.
     * Вызывается при смене значения в дропдауне "Obfuscation Profile".
     * Если templateId пустой ("-- Manual entry --") — поля НЕ сбрасываются,
     * пользователь продолжает вводить вручную.
     */
    onInterfaceTemplateSelect(templateId) {
      if (!templateId) return; // manual entry — не трогаем поля
      const tmpl = (this.templates || []).find(t => t.id === templateId);
      if (!tmpl) return;
      this.interfaceCreate.settings = {
        jc: tmpl.jc,    jmin: tmpl.jmin,  jmax: tmpl.jmax,
        s1: tmpl.s1,    s2: tmpl.s2,      s3: tmpl.s3,   s4: tmpl.s4,
        h1: tmpl.h1,    h2: tmpl.h2,      h3: tmpl.h3,   h4: tmpl.h4,
        i1: tmpl.i1 || '', i2: tmpl.i2 || '', i3: tmpl.i3 || '',
        i4: tmpl.i4 || '', i5: tmpl.i5 || '',
      };
    },
  },
  filters: {
    bytes,
    timeago: (value) => {
      return timeago.format(value, i18n.locale);
    },
    expiredDateFormat: (value) => {
      if (value === null) return i18n.t('Permanent');
      const dateTime = new Date(value);
      const options = { year: 'numeric', month: 'long', day: 'numeric' };
      return dateTime.toLocaleDateString(i18n.locale, options);
    },
    expiredDateEditFormat: (value) => {
      if (value === null) return 'yyyy-MM-dd';
    },
  },
  mounted() {
    this.prefersDarkScheme.addListener(this.handlePrefersChange);
    this.setTheme(this.uiTheme);

    this.api = new API();
    this.api.getSession()
      .then((session) => {
        this.authenticated = session.authenticated;
        this.requiresPassword = session.requiresPassword;
        this.refresh({
          updateCharts: this.updateCharts,
        }).catch((err) => {
          alert(err.message || err.toString());
        });
        // Load tunnel interfaces at startup (default page); then populate dashboard immediately
        this.loadTunnelInterfaces().then(() => {
          if (!this.activeInterfaceId) this.refreshAllPeers();
        }).catch(console.error);
        // Load settings + templates at startup so they are available
        // on any page (e.g. "Obfuscation Profile" dropdown in Create Interface modal).
        this.loadSettings();
      })
      .catch((err) => {
        alert(err.message || err.toString());
      });

    this.api.getRememberMeEnabled()
      .then((rememberMeEnabled) => {
        this.rememberMeEnabled = rememberMeEnabled;
      });

    setInterval(() => {
      this.refresh({
        updateCharts: this.updateCharts,
      }).catch(console.error);
      if (this.activePage === 'interfaces') {
        if (this.activeInterfaceId) {
          this.refreshPeers({
            updateCharts: this.updateCharts,
          }).catch(console.error);
        } else {
          // Dashboard mode: refresh all interfaces' peers
          this.refreshAllPeers({
            updateCharts: this.updateCharts,
          }).catch(console.error);
        }
      }
      if (this.activePage === 'gateways') {
        this.refreshGateways().catch(console.error);
      }
    }, 1000);

    this.api.getuiTrafficStats()
      .then((res) => {
        this.uiTrafficStats = res;
      })
      .catch(() => {
        this.uiTrafficStats = false;
      });

    this.api.getChartType()
      .then((res) => {
        this.uiChartType = parseInt(res, 10);
      })
      .catch(() => {
        this.uiChartType = 0;
      });

    this.api.getWGEnableOneTimeLinks()
      .then((res) => {
        this.enableOneTimeLinks = res;
      })
      .catch(() => {
        this.enableOneTimeLinks = false;
      });

    this.api.getUiSortClients()
      .then((res) => {
        this.enableSortClient = res;
      })
      .catch(() => {
        this.enableSortClient = false;
      });

    this.api.getWGEnableExpireTime()
      .then((res) => {
        this.enableExpireTime = res;
      })
      .catch(() => {
        this.enableExpireTime = false;
      });

    this.api.getAvatarSettings()
      .then((res) => {
        this.avatarSettings = res;
      })
      .catch(() => {
          this.avatarSettings = {
            'dicebear': null,
            'gravatar': false,
          };
      });

    Promise.resolve().then(async () => {
      const lang = await this.api.getLang();
      if (lang !== localStorage.getItem('lang') && i18n.availableLocales.includes(lang)) {
        localStorage.setItem('lang', lang);
        i18n.locale = lang;
      }

      const currentRelease = await this.api.getRelease();
      const latestRelease = await fetch('https://wg-easy.github.io/wg-easy/changelog.json')
        .then((res) => res.json())
        .then((releases) => {
          const releasesArray = Object.entries(releases).map(([version, changelog]) => ({
            version: parseInt(version, 10),
            changelog,
          }));
          releasesArray.sort((a, b) => {
            return b.version - a.version;
          });

          return releasesArray[0];
        });

      if (currentRelease >= latestRelease.version) return;

      this.currentRelease = currentRelease;
      this.latestRelease = latestRelease;
    }).catch((err) => console.error(err));
  },
  watch: {
    activeInterfaceId(newId) {
      if (newId) {
        this.selectedInterface = this.currentInterface;
        this.refreshPeers({ updateCharts: false });
      } else {
        this.selectedInterface = null;
        this.selectedInterfacePeers = [];
        // Switch to dashboard — immediately load all peers
        this.refreshAllPeers({ updateCharts: false });
      }
    },
  },
  computed: {
    currentInterface() {
      if (!this.activeInterfaceId) return null;
      return this.tunnelInterfaces.find(i => i.id === this.activeInterfaceId) || null;
    },
    chartOptionsTX() {
      const opts = {
        ...this.chartOptions,
        colors: [CHART_COLORS.tx[this.theme]],
      };
      opts.chart.type = UI_CHART_TYPES[this.uiChartType].type || false;
      opts.stroke.width = UI_CHART_TYPES[this.uiChartType].strokeWidth;
      return opts;
    },
    chartOptionsRX() {
      const opts = {
        ...this.chartOptions,
        colors: [CHART_COLORS.rx[this.theme]],
      };
      opts.chart.type = UI_CHART_TYPES[this.uiChartType].type || false;
      opts.stroke.width = UI_CHART_TYPES[this.uiChartType].strokeWidth;
      return opts;
    },
    updateCharts() {
      return this.uiChartType > 0 && this.uiShowCharts;
    },
    theme() {
      if (this.uiTheme === 'auto') {
        return this.prefersDarkScheme.matches ? 'dark' : 'light';
      }
      return this.uiTheme;
    },
  },
});
