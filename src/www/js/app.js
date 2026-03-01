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

    // WAN Tunnels (old architecture - deprecated)
    activeTab: 'clients',
    wanTunnels: [],
    showWanTunnelCreate: false,

    // Tunnel Interfaces (new architecture)
    tunnelInterfaces: [],
    tunnelInterfacesSubTab: 'interfaces', // 'interfaces' or 'peers'
    selectedInterface: null,
    selectedInterfacePeers: [],
    showInterfaceCreate: false,
    showPeerCreate: false,
    loadingInterfaceId: null, // ID интерфейса, над которым выполняется операция
    interfaceCreate: {
      name: '',
      protocol: 'wireguard-1.0',
      address: '',
      listenPort: '',
      settings: {
        jc: 6, jmin: 10, jmax: 50,
        s1: 64, s2: 67, s3: 64, s4: 4,
        h1: '', h2: '', h3: '', h4: '',
        i1: '', i2: '', i3: '', i4: '', i5: '',
      },
    },
    peerCreate: {
      name: '',
      publicKey: '',
      endpoint: '',
      allowedIPs: '',
      remoteAddress: '',
      persistentKeepalive: 25,
    },
    wanTunnelCreate: {
      name: '',
      protocol: 'wireguard-1.0',
      localTunnelAddress: '',    // Tunnel P2P IP (this side)
      remoteTunnelAddress: '',   // Tunnel P2P IP (other side)
      localSubnet: '',
      remoteSubnet: '',
      remoteEndpoint: '',
      remotePublicKey: '',
      settings: {
        jc: 6,
        jmin: 10,
        jmax: 50,
        s1: 64,
        s2: 67,
        s3: 64,
        s4: 4,
        h1: '',
        h2: '',
        h3: '',
        h4: '',
      },
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
          return this.refresh();
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

    // WAN Tunnels Methods
    async loadWanTunnels() {
      try {
        const res = await fetch('/api/wireguard/wan-tunnels', { credentials: 'include' });
        if (!res.ok) throw new Error(res.statusText);
        this.wanTunnels = await res.json();
      } catch (err) {
        console.error('Failed to load WAN tunnels:', err);
      }
    },

    async createWanTunnel() {
      try {
        if (!this.wanTunnelCreate.name || !this.wanTunnelCreate.localSubnet || 
            !this.wanTunnelCreate.remoteSubnet || !this.wanTunnelCreate.remoteEndpoint || 
            !this.wanTunnelCreate.remotePublicKey) {
          alert('Please fill all required fields');
          return;
        }

        if (this.wanTunnelCreate.protocol === 'amneziawg-2.0') {
          if (!this.wanTunnelCreate.settings.h1 || !this.wanTunnelCreate.settings.h2 || 
              !this.wanTunnelCreate.settings.h3 || !this.wanTunnelCreate.settings.h4) {
            alert('Please set H1-H4 parameters for AWG 2.0');
            return;
          }
        }

        const payload = {
          name: this.wanTunnelCreate.name,
          protocol: this.wanTunnelCreate.protocol,
          localTunnelAddress: this.wanTunnelCreate.localTunnelAddress,    // ДОБАВЛЕНО
          remoteTunnelAddress: this.wanTunnelCreate.remoteTunnelAddress,  // ДОБАВЛЕНО
          localSubnet: this.wanTunnelCreate.localSubnet,
          remoteSubnet: this.wanTunnelCreate.remoteSubnet,
          remoteEndpoint: this.wanTunnelCreate.remoteEndpoint,
          remotePublicKey: this.wanTunnelCreate.remotePublicKey,
        };

        if (this.wanTunnelCreate.protocol === 'amneziawg-2.0') {
          payload.settings = this.wanTunnelCreate.settings;
        }

        const res = await fetch('/api/wireguard/wan-tunnels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const error = await res.json();
          throw new Error(error.error || res.statusText);
        }

        this.showWanTunnelCreate = false;
        this.wanTunnelCreate = {
          name: '',
          protocol: 'wireguard-1.0',
          localTunnelAddress: '',    // ДОБАВЛЕНО
          remoteTunnelAddress: '',   // ДОБАВЛЕНО
          localSubnet: '',
          remoteSubnet: '',
          remoteEndpoint: '',
          remotePublicKey: '',
          settings: { jc: 6, jmin: 10, jmax: 50, s1: 64, s2: 67, s3: 64, s4: 4, h1: '', h2: '', h3: '', h4: '' },
        };

        await this.loadWanTunnels();
        alert('WAN tunnel created!');
      } catch (err) {
        console.error('Failed to create WAN tunnel:', err);
        alert(`Failed: ${err.message}`);
      }
    },

    async deleteWanTunnel(tunnel) {
      if (!confirm(`Delete "${tunnel.name}"?`)) return;
      try {
        const res = await fetch(`/api/wireguard/wan-tunnels/${tunnel.id}`, {
          method: 'DELETE',
          credentials: 'include',
        });
        if (!res.ok) throw new Error(res.statusText);
        await this.loadWanTunnels();
        alert('Deleted!');
      } catch (err) {
        console.error('Delete failed:', err);
        alert(`Failed: ${err.message}`);
      }
    },

    async restartWanTunnel(tunnel) {
      try {
        const res = await fetch(`/api/wireguard/wan-tunnels/${tunnel.id}/restart`, {
          method: 'POST',
          credentials: 'include',
        });
        if (!res.ok) throw new Error(res.statusText);
        await this.loadWanTunnels();
        alert('Restarted!');
      } catch (err) {
        console.error('Restart failed:', err);
        alert(`Failed: ${err.message}`);
      }
    },

    async downloadWanTunnelConfig(tunnel) {
      try {
        const res = await fetch(`/api/wireguard/wan-tunnels/${tunnel.id}/config`, { credentials: 'include' });
        if (!res.ok) throw new Error(res.statusText);
        const config = await res.text();
        const blob = new Blob([config], { type: 'text/plain' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${tunnel.id}-remote.conf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
      } catch (err) {
        console.error('Download failed:', err);
        alert(`Failed: ${err.message}`);
      }
    },

    useProductionDefaults() {
      const rand = () => {
        const min = Math.floor(Math.random() * 2000000000) + 100000000;
        const max = Math.min(min + Math.floor(Math.random() * 500000000) + 200000000, 2147483647);
        return `${min}-${max}`;
      };
      this.wanTunnelCreate.settings = {
        jc: 6, jmin: 10, jmax: 50, s1: 64, s2: 67, s3: 64, s4: 4,
        h1: rand(), h2: rand(), h3: rand(), h4: rand(),
      };
      alert('Defaults applied!');
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

        if (this.interfaceCreate.protocol === 'amneziawg-2.0') {
          if (!this.interfaceCreate.settings.h1 || !this.interfaceCreate.settings.h2 ||
              !this.interfaceCreate.settings.h3 || !this.interfaceCreate.settings.h4) {
            alert('Please set H1-H4 parameters for AWG 2.0');
            return;
          }
        }

        const payload = {
          name: this.interfaceCreate.name,
          protocol: this.interfaceCreate.protocol,
          address: this.interfaceCreate.address || undefined,
          listenPort: this.interfaceCreate.listenPort ? parseInt(this.interfaceCreate.listenPort, 10) : undefined,
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

        this.showInterfaceCreate = false;
        this.interfaceCreate = {
          name: '', protocol: 'wireguard-1.0', address: '', listenPort: '',
          settings: { jc: 6, jmin: 10, jmax: 50, s1: 64, s2: 67, s3: 64, s4: 4, h1: '', h2: '', h3: '', h4: '', i1: '', i2: '', i3: '', i4: '', i5: '' },
        };

        await this.loadTunnelInterfaces();
        alert('Interface created!');
      } catch (err) {
        console.error('Failed to create interface:', err);
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
        await this.loadTunnelInterfaces();
        if (this.selectedInterface && this.selectedInterface.id === iface.id) {
          this.selectedInterface = null;
          this.selectedInterfacePeers = [];
        }
        alert('Interface deleted!');
      } catch (err) {
        console.error('Delete failed:', err);
        alert(`Failed: ${err.message}`);
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
        if (!res.ok) throw new Error(res.statusText);
        await this.loadTunnelInterfaces();
      } catch (err) {
        console.error('Start failed:', err);
        alert(`Failed: ${err.message}`);
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
        if (!res.ok) throw new Error(res.statusText);
        await this.loadTunnelInterfaces();
      } catch (err) {
        console.error('Stop failed:', err);
        alert(`Failed: ${err.message}`);
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
        if (!res.ok) throw new Error(res.statusText);
        await this.loadTunnelInterfaces();
      } catch (err) {
        console.error('Restart failed:', err);
        alert(`Failed: ${err.message}`);
      } finally {
        this.loadingInterfaceId = null;
      }
    },

    async selectInterface(iface) {
      this.selectedInterface = iface;
      this.tunnelInterfacesSubTab = 'peers';
      await this.loadInterfacePeers(iface.id);
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
      if (!this.selectedInterface) {
        alert('Please select an interface first');
        return;
      }
      try {
        if (!this.peerCreate.name || !this.peerCreate.publicKey || !this.peerCreate.allowedIPs) {
          alert('Please fill name, public key, and allowed IPs');
          return;
        }

        const payload = {
          name: this.peerCreate.name,
          publicKey: this.peerCreate.publicKey,
          endpoint: this.peerCreate.endpoint || undefined,
          allowedIPs: this.peerCreate.allowedIPs,
          remoteAddress: this.peerCreate.remoteAddress || undefined,
          persistentKeepalive: this.peerCreate.persistentKeepalive || 25,
        };

        const res = await fetch(`/api/tunnel-interfaces/${this.selectedInterface.id}/peers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const error = await res.json();
          throw new Error(error.message || res.statusText);
        }

        this.showPeerCreate = false;
        this.peerCreate = { name: '', publicKey: '', endpoint: '', allowedIPs: '', remoteAddress: '', persistentKeepalive: 25 };

        await this.loadInterfacePeers(this.selectedInterface.id);
        await this.loadTunnelInterfaces();
        alert('Peer created!');
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
        const res = await fetch(`/api/tunnel-interfaces/${this.selectedInterface.id}/peers/${peer.id}/config`, {
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

    useInterfaceDefaults() {
      // H1-H4: unique uint32 values, must NOT be ranges and must NOT equal
      // standard WireGuard packet types 1-4 (causes "headers must not overlap" error)
      const usedH = new Set([1, 2, 3, 4]);
      const randH = () => {
        let v;
        do { v = Math.floor(Math.random() * 0xFFFFFFFB) + 5; } while (usedH.has(v));
        usedH.add(v);
        return v;
      };
      this.interfaceCreate.settings = {
        jc: 6, jmin: 10, jmax: 50, s1: 64, s2: 67, s3: 64, s4: 4,
        h1: randH(), h2: randH(), h3: randH(), h4: randH(),
        i1: '', i2: '', i3: '', i4: '', i5: '',
      };
      alert('Defaults applied!');
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
  computed: {
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
