'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const basicAuth = require('basic-auth');
const QRCode = require('qrcode');
const { createServer } = require('node:http');
const { stat, readFile } = require('node:fs/promises');
const { resolve, sep } = require('node:path');

const expressSession = require('express-session');
const debug = require('debug')('Server');
const TunnelManager = require('./TunnelManager');
const InterfaceManager = require('./InterfaceManager');
const Settings = require('./Settings');

const {
  createApp,
  createError,
  createRouter,
  defineEventHandler,
  fromNodeMiddleware,
  getRouterParam,
  toNodeListener,
  readBody,
  setHeader,
  serveStatic,
} = require('h3');

const WireGuard = require('../services/WireGuard');

const {
  PORT,
  WEBUI_HOST,
  RELEASE,
  PASSWORD_HASH,
  MAX_AGE,
  LANG,
  UI_TRAFFIC_STATS,
  UI_CHART_TYPE,
  WG_ENABLE_ONE_TIME_LINKS,
  UI_ENABLE_SORT_CLIENTS,
  WG_ENABLE_EXPIRES_TIME,
  ENABLE_PROMETHEUS_METRICS,
  PROMETHEUS_METRICS_PASSWORD,
  DICEBEAR_TYPE,
  USE_GRAVATAR,
} = require('../config');

const requiresPassword = !!PASSWORD_HASH;
const requiresPrometheusPassword = !!PROMETHEUS_METRICS_PASSWORD;

/**
 * Checks if `password` matches the PASSWORD_HASH.
 *
 * If environment variable is not set, the password is always invalid.
 *
 * @param {string} password String to test
 * @returns {boolean} true if matching environment, otherwise false
 */
const isPasswordValid = (password, hash) => {
  if (typeof password !== 'string') {
    return false;
  }
  if (hash) {
    return bcrypt.compareSync(password, hash);
  }

  return false;
};

const cronJobEveryMinute = async () => {
  await WireGuard.cronJobEveryMinute();
  setTimeout(cronJobEveryMinute, 60 * 1000);
};

module.exports = class Server {

  constructor() {
    const app = createApp();
    this.app = app;

    // ========================================================================
    // Initialize TunnelManager
    // ========================================================================
    this.tunnelManager = new TunnelManager();
    const tunnelManager = this.tunnelManager; // Сохраняем ссылку для использования в handlers

    app.use(fromNodeMiddleware(expressSession({
      secret: crypto.randomBytes(256).toString('hex'),
      resave: true,
      saveUninitialized: true,
    })));

    const router = createRouter();
    app.use(router);

    router
      .get('/api/release', defineEventHandler((event) => {
        setHeader(event, 'Content-Type', 'application/json');
        return RELEASE;
      }))

      .get('/api/lang', defineEventHandler((event) => {
        setHeader(event, 'Content-Type', 'application/json');
        return `"${LANG}"`;
      }))

      .get('/api/remember-me', defineEventHandler((event) => {
        setHeader(event, 'Content-Type', 'application/json');
        return MAX_AGE > 0;
      }))

      .get('/api/ui-traffic-stats', defineEventHandler((event) => {
        setHeader(event, 'Content-Type', 'application/json');
        return `${UI_TRAFFIC_STATS}`;
      }))

      .get('/api/ui-chart-type', defineEventHandler((event) => {
        setHeader(event, 'Content-Type', 'application/json');
        return `"${UI_CHART_TYPE}"`;
      }))

      .get('/api/wg-enable-one-time-links', defineEventHandler((event) => {
        setHeader(event, 'Content-Type', 'application/json');
        return `${WG_ENABLE_ONE_TIME_LINKS}`;
      }))

      .get('/api/ui-sort-clients', defineEventHandler((event) => {
        setHeader(event, 'Content-Type', 'application/json');
        return `${UI_ENABLE_SORT_CLIENTS}`;
      }))

      .get('/api/wg-enable-expire-time', defineEventHandler((event) => {
        setHeader(event, 'Content-Type', 'application/json');
        return `${WG_ENABLE_EXPIRES_TIME}`;
      }))

      .get('/api/ui-avatar-settings', defineEventHandler((event) => {
        setHeader(event, 'Content-Type', 'application/json');
        return {
          dicebear: DICEBEAR_TYPE,
          gravatar: USE_GRAVATAR,
        }
      }))

      // Authentication
      .get('/api/session', defineEventHandler((event) => {
        const authenticated = requiresPassword
          ? !!(event.node.req.session && event.node.req.session.authenticated)
          : true;

        return {
          requiresPassword,
          authenticated,
        };
      }))
      .get('/cnf/:clientOneTimeLink', defineEventHandler(async (event) => {
        if (WG_ENABLE_ONE_TIME_LINKS === 'false') {
          throw createError({
            status: 404,
            message: 'Invalid state',
          });
        }
        const clientOneTimeLink = getRouterParam(event, 'clientOneTimeLink');

        // Check admin tunnel clients first
        const clients = await WireGuard.getClients();
        const client = clients.find((client) => client.oneTimeLink === clientOneTimeLink);
        if (client) {
          const clientId = client.id;
          const config = await WireGuard.getClientConfiguration({ clientId });
          await WireGuard.eraseOneTimeLink({ clientId });
          setHeader(event, 'Content-Disposition', `attachment; filename="${clientOneTimeLink}.conf"`);
          setHeader(event, 'Content-Type', 'text/plain');
          return config;
        }

        // Check tunnel interface peers
        const manager = await InterfaceManager.getInstance();
        for (const iface of manager.getAllInterfaces()) {
          for (const peer of iface.getAllPeers()) {
            if (peer.oneTimeLink === clientOneTimeLink) {
              const config = peer.generateRemoteConfig(iface.data);
              // Erase one-time link after use
              await iface.updatePeer(peer.id, { oneTimeLink: null });
              setHeader(event, 'Content-Disposition', `attachment; filename="${clientOneTimeLink}.conf"`);
              setHeader(event, 'Content-Type', 'text/plain');
              return config;
            }
          }
        }

        // Not found
        throw createError({ status: 404, message: 'Link not found or expired' });
      }))
      .post('/api/session', defineEventHandler(async (event) => {
        const { password, remember } = await readBody(event);

        if (!requiresPassword) {
          // if no password is required, the API should never be called.
          // Do not automatically authenticate the user.
          throw createError({
            status: 401,
            message: 'Invalid state',
          });
        }

        if (!isPasswordValid(password, PASSWORD_HASH)) {
          throw createError({
            status: 401,
            message: 'Incorrect Password',
          });
        }

        if (MAX_AGE && remember) {
          event.node.req.session.cookie.maxAge = MAX_AGE;
        }
        event.node.req.session.authenticated = true;
        event.node.req.session.save();

        debug(`New Session: ${event.node.req.session.id}`);

        return { success: true };
      }));

    // WireGuard
    app.use(
      fromNodeMiddleware((req, res, next) => {
        if (!requiresPassword || !req.url.startsWith('/api/')) {
          return next();
        }

        if (req.session && req.session.authenticated) {
          return next();
        }

        if (req.url.startsWith('/api/') && req.headers['authorization']) {
          if (isPasswordValid(req.headers['authorization'], PASSWORD_HASH)) {
            return next();
          }
          return res.status(401).json({
            error: 'Incorrect Password',
          });
        }

        return res.status(401).json({
          error: 'Not Logged In',
        });
      }),
    );

    const router2 = createRouter();
    app.use(router2);

    router2
      .delete('/api/session', defineEventHandler((event) => {
        const sessionId = event.node.req.session.id;

        event.node.req.session.destroy();

        debug(`Deleted Session: ${sessionId}`);
        return { success: true };
      }))
      .get('/api/wireguard/client', defineEventHandler(() => {
        return WireGuard.getClients();
      }))
      .get('/api/wireguard/client/:clientId/qrcode.svg', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        const svg = await WireGuard.getClientQRCodeSVG({ clientId });
        setHeader(event, 'Content-Type', 'image/svg+xml');
        return svg;
      }))
      .get('/api/wireguard/client/:clientId/configuration', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        const client = await WireGuard.getClient({ clientId });
        const config = await WireGuard.getClientConfiguration({ clientId });
        const configName = client.name
          .replace(/[^a-zA-Z0-9_=+.-]/g, '-')
          .replace(/(-{2,}|-$)/g, '-')
          .replace(/-$/, '')
          .substring(0, 32);
        setHeader(event, 'Content-Disposition', `attachment; filename="${configName || clientId}.conf"`);
        setHeader(event, 'Content-Type', 'text/plain');
        return config;
      }))
      .post('/api/wireguard/client', defineEventHandler(async (event) => {
        const { name } = await readBody(event);
        const { expiredDate } = await readBody(event);
        await WireGuard.createClient({ name, expiredDate });
        return { success: true };
      }))
      .delete('/api/wireguard/client/:clientId', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        await WireGuard.deleteClient({ clientId });
        return { success: true };
      }))
      .post('/api/wireguard/client/:clientId/enable', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        if (clientId === '__proto__' || clientId === 'constructor' || clientId === 'prototype') {
          throw createError({ status: 403 });
        }
        await WireGuard.enableClient({ clientId });
        return { success: true };
      }))
      .post('/api/wireguard/client/:clientId/generateOneTimeLink', defineEventHandler(async (event) => {
        if (WG_ENABLE_ONE_TIME_LINKS === 'false') {
          throw createError({
            status: 404,
            message: 'Invalid state',
          });
        }
        const clientId = getRouterParam(event, 'clientId');
        if (clientId === '__proto__' || clientId === 'constructor' || clientId === 'prototype') {
          throw createError({ status: 403 });
        }
        await WireGuard.generateOneTimeLink({ clientId });
        return { success: true };
      }))
      .post('/api/wireguard/client/:clientId/disable', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        if (clientId === '__proto__' || clientId === 'constructor' || clientId === 'prototype') {
          throw createError({ status: 403 });
        }
        await WireGuard.disableClient({ clientId });
        return { success: true };
      }))
      .put('/api/wireguard/client/:clientId/name', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        if (clientId === '__proto__' || clientId === 'constructor' || clientId === 'prototype') {
          throw createError({ status: 403 });
        }
        const { name } = await readBody(event);
        await WireGuard.updateClientName({ clientId, name });
        return { success: true };
      }))
      .put('/api/wireguard/client/:clientId/address', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        if (clientId === '__proto__' || clientId === 'constructor' || clientId === 'prototype') {
          throw createError({ status: 403 });
        }
        const { address } = await readBody(event);
        await WireGuard.updateClientAddress({ clientId, address });
        return { success: true };
      }))
      .put('/api/wireguard/client/:clientId/expireDate', defineEventHandler(async (event) => {
        const clientId = getRouterParam(event, 'clientId');
        if (clientId === '__proto__' || clientId === 'constructor' || clientId === 'prototype') {
          throw createError({ status: 403 });
        }
        const { expireDate } = await readBody(event);
        await WireGuard.updateClientExpireDate({ clientId, expireDate });
        return { success: true };
      }))

      // ========================================================================
      // WAN Tunnels API
      // ========================================================================

      /**
       * GET /api/wireguard/wan-tunnels
       * Получить список всех WAN туннелей
       */
      .get('/api/wireguard/wan-tunnels', defineEventHandler(async (event) => {
        const tunnels = await tunnelManager.getWanTunnels();
        return tunnels;
      }))

      /**
       * POST /api/wireguard/wan-tunnels
       * Создать новый WAN туннель
       */
      .post('/api/wireguard/wan-tunnels', defineEventHandler(async (event) => {
        const data = await readBody(event);
        const tunnel = await tunnelManager.createWanTunnel(data);
        return tunnel;
      }))

      /**
       * GET /api/wireguard/wan-tunnels/:id
       * Получить конкретный WAN туннель
       */
      .get('/api/wireguard/wan-tunnels/:id', defineEventHandler(async (event) => {
        const tunnelId = getRouterParam(event, 'id');
        const tunnel = tunnelManager.getWanTunnel(tunnelId);
        const status = await tunnel.getStatus();
        
        return {
          ...tunnel.toJSON(),
          status,
        };
      }))

      /**
       * DELETE /api/wireguard/wan-tunnels/:id
       * Удалить WAN туннель
       */
      .delete('/api/wireguard/wan-tunnels/:id', defineEventHandler(async (event) => {
        const tunnelId = getRouterParam(event, 'id');
        await tunnelManager.deleteWanTunnel(tunnelId);
        return { success: true };
      }))

      /**
       * POST /api/wireguard/wan-tunnels/:id/enable
       * Включить туннель
       */
      .post('/api/wireguard/wan-tunnels/:id/enable', defineEventHandler(async (event) => {
        const tunnelId = getRouterParam(event, 'id');
        await tunnelManager.enableWanTunnel(tunnelId);
        return { success: true };
      }))

      /**
       * POST /api/wireguard/wan-tunnels/:id/disable
       * Отключить туннель
       */
      .post('/api/wireguard/wan-tunnels/:id/disable', defineEventHandler(async (event) => {
        const tunnelId = getRouterParam(event, 'id');
        await tunnelManager.disableWanTunnel(tunnelId);
        return { success: true };
      }))

      /**
       * POST /api/wireguard/wan-tunnels/:id/restart
       * Перезапустить туннель
       */
      .post('/api/wireguard/wan-tunnels/:id/restart', defineEventHandler(async (event) => {
        const tunnelId = getRouterParam(event, 'id');
        await tunnelManager.restartWanTunnel(tunnelId);
        return { success: true };
      }))

      /**
       * GET /api/wireguard/wan-tunnels/:id/status
       * Получить статус туннеля
       */
      .get('/api/wireguard/wan-tunnels/:id/status', defineEventHandler(async (event) => {
        const tunnelId = getRouterParam(event, 'id');
        const tunnel = tunnelManager.getWanTunnel(tunnelId);
        const status = await tunnel.getStatus();
        return status;
      }))

      /**
       * GET /api/wireguard/wan-tunnels/:id/config
       * Получить конфиг для удалённой стороны туннеля
       */
      .get('/api/wireguard/wan-tunnels/:id/config', defineEventHandler(async (event) => {
        const tunnelId = getRouterParam(event, 'id');
        const tunnel = tunnelManager.getWanTunnel(tunnelId);
        const config = await tunnel.getRemoteConfig();

        setHeader(event, 'Content-Type', 'text/plain');
        setHeader(event, 'Content-Disposition', `attachment; filename="${tunnelId}-remote.conf"`);
        return config;
      }))

      // ========================================================================
      // Tunnel Interfaces API (New Architecture)
      // ========================================================================

      /**
       * GET /api/tunnel-interfaces
       * Получить список всех интерфейсов
       */
      .get('/api/tunnel-interfaces', defineEventHandler(async () => {
        const manager = await InterfaceManager.getInstance();
        const interfaces = manager.getAllInterfaces();
        return {
          interfaces: interfaces.map(iface => iface.toJSON()),
        };
      }))

      /**
       * POST /api/tunnel-interfaces
       * Создать новый интерфейс
       */
      .post('/api/tunnel-interfaces', defineEventHandler(async (event) => {
        const { name, protocol, address, listenPort, settings, disableRoutes } = await readBody(event);

        if (!name) {
          throw createError({ status: 400, message: 'Name is required' });
        }

        if (protocol === 'amneziawg-2.0' && !settings) {
          throw createError({ status: 400, message: 'Settings required for AmneziaWG 2.0' });
        }

        const manager = await InterfaceManager.getInstance();
        const iface = await manager.createInterface({ name, protocol, address, listenPort, settings, disableRoutes });

        debug(`Interface created: ${iface.id}`);
        return { interface: iface.toJSON() };
      }))

      /**
       * GET /api/tunnel-interfaces/:id
       * Получить информацию об интерфейсе
       */
      .get('/api/tunnel-interfaces/:id', defineEventHandler(async (event) => {
        const id = getRouterParam(event, 'id');
        const manager = await InterfaceManager.getInstance();
        const iface = manager.getInterface(id);

        if (!iface) {
          throw createError({ status: 404, message: 'Interface not found' });
        }

        return { interface: iface.toJSON() };
      }))

      /**
       * PATCH /api/tunnel-interfaces/:id
       * Обновить интерфейс
       */
      .patch('/api/tunnel-interfaces/:id', defineEventHandler(async (event) => {
        const id = getRouterParam(event, 'id');
        const updates = await readBody(event);

        const manager = await InterfaceManager.getInstance();
        const iface = await manager.updateInterface(id, updates);

        debug(`Interface updated: ${id}`);
        return { interface: iface.toJSON() };
      }))

      /**
       * DELETE /api/tunnel-interfaces/:id
       * Удалить интерфейс
       */
      .delete('/api/tunnel-interfaces/:id', defineEventHandler(async (event) => {
        const id = getRouterParam(event, 'id');
        const manager = await InterfaceManager.getInstance();
        await manager.deleteInterface(id);

        debug(`Interface deleted: ${id}`);
        return { success: true };
      }))

      /**
       * POST /api/tunnel-interfaces/:id/start
       * Запустить интерфейс
       */
      .post('/api/tunnel-interfaces/:id/start', defineEventHandler(async (event) => {
        const id = getRouterParam(event, 'id');
        const manager = await InterfaceManager.getInstance();
        const iface = await manager.startInterface(id);

        debug(`Interface started: ${id}`);
        return { interface: iface.toJSON() };
      }))

      /**
       * POST /api/tunnel-interfaces/:id/stop
       * Остановить интерфейс
       */
      .post('/api/tunnel-interfaces/:id/stop', defineEventHandler(async (event) => {
        const id = getRouterParam(event, 'id');
        const manager = await InterfaceManager.getInstance();
        const iface = await manager.stopInterface(id);

        debug(`Interface stopped: ${id}`);
        return { interface: iface.toJSON() };
      }))

      /**
       * POST /api/tunnel-interfaces/:id/restart
       * Перезапустить интерфейс
       */
      .post('/api/tunnel-interfaces/:id/restart', defineEventHandler(async (event) => {
        const id = getRouterParam(event, 'id');
        const manager = await InterfaceManager.getInstance();
        const iface = await manager.restartInterface(id);

        debug(`Interface restarted: ${id}`);
        return { interface: iface.toJSON() };
      }))

      // ========================================================================
      // Peers API (for Tunnel Interfaces)
      // ========================================================================

      /**
       * GET /api/tunnel-interfaces/:id/peers
       * Получить список peers интерфейса
       */
      .get('/api/tunnel-interfaces/:id/peers', defineEventHandler(async (event) => {
        const id = getRouterParam(event, 'id');
        const manager = await InterfaceManager.getInstance();
        const iface = manager.getInterface(id);
        if (!iface) {
          throw createError({ status: 404, message: 'Interface not found' });
        }

        // Fetch live transfer stats before returning
        await iface.getStatus();
        const peers = iface.getAllPeers();

        return { peers: peers.map(peer => peer.toAPIJSON()) };
      }))

      /**
       * POST /api/tunnel-interfaces/:id/peers
       * Добавить peer к интерфейсу.
       * Supports autoAllocateIP for one-click creation.
       */
      .post('/api/tunnel-interfaces/:id/peers', defineEventHandler(async (event) => {
        const id = getRouterParam(event, 'id');
        const body = await readBody(event);

        const { name, autoAllocateIP } = body;

        if (!name) {
          throw createError({ status: 400, message: 'name is required' });
        }
        if (!autoAllocateIP && !body.allowedIPs) {
          throw createError({ status: 400, message: 'allowedIPs is required (or use autoAllocateIP)' });
        }
        if (!autoAllocateIP && !body.generateKeys && !body.publicKey) {
          throw createError({ status: 400, message: 'publicKey is required when not using generateKeys' });
        }

        // Get defaults from global settings
        const settings = await Settings.getInstance();
        const defaults = settings.getPeerDefaults();

        const peerData = {
          name,
          generateKeys: body.generateKeys || !!autoAllocateIP,
          autoAllocateIP: !!autoAllocateIP,
          publicKey: body.publicKey,
          endpoint: body.endpoint || '',
          allowedIPs: body.allowedIPs,
          clientAllowedIPs: body.clientAllowedIPs || defaults.clientAllowedIPs,
          persistentKeepalive: body.persistentKeepalive || defaults.persistentKeepalive,
          peerType: body.peerType || 'client',
          expiredAt: body.expiredDate ? new Date(body.expiredDate).toISOString() : null,
        };

        const manager = await InterfaceManager.getInstance();
        const peer = await manager.addPeer(id, peerData);

        debug(`Peer added: ${peer.id} to ${id}`);
        return { peer: peer.toJSON() };
      }))

      /**
       * POST /api/tunnel-interfaces/:id/peers/import-json
       * Создать Interconnect peer из JSON-файла экспортированного другой стороной.
       *
       * Body (JSON экспортированный с другой стороны):
       *   name            — имя пира (можно переименовать)
       *   publicKey       — публичный ключ удалённой стороны
       *   presharedKey    — PSK (должен совпадать на обеих сторонах)
       *   endpoint        — удалённый endpoint (host:port)
       *   persistentKeepalive — keepalive
       *   allowedIPs      — туннельный IP удалённой стороны /32 (AllowedIPs в нашем конфиге)
       *   clientAllowedIPs — что мы будем маршрутизировать через этот пир
       *
       * Отличие от POST /peers: тип всегда 'interconnect', generateKeys=false, autoAllocateIP=false.
       * Ключи не генерируются — они уже содержатся в импортируемом JSON.
       */
      .post('/api/tunnel-interfaces/:id/peers/import-json', defineEventHandler(async (event) => {
        const id = getRouterParam(event, 'id');
        const body = await readBody(event);

        if (!body.publicKey) {
          throw createError({ status: 400, message: 'publicKey is required in import JSON' });
        }
        if (!body.allowedIPs) {
          throw createError({ status: 400, message: 'allowedIPs is required in import JSON' });
        }
        if (!body.name) {
          throw createError({ status: 400, message: 'name is required' });
        }

        const peerData = {
          name: body.name,
          peerType: 'interconnect',
          publicKey: body.publicKey,
          presharedKey: body.presharedKey || '',
          endpoint: body.endpoint || '',
          allowedIPs: body.allowedIPs,
          clientAllowedIPs: body.clientAllowedIPs || '0.0.0.0/0',
          persistentKeepalive: body.persistentKeepalive || 25,
          generateKeys: false,
          autoAllocateIP: false,
        };

        const manager = await InterfaceManager.getInstance();
        const peer = await manager.addPeer(id, peerData);

        debug(`Peer imported from JSON: ${peer.id} to ${id}`);
        return { peer: peer.toJSON() };
      }))

      /**
       * GET /api/tunnel-interfaces/:id/peers/:peerId
       * Получить информацию о peer
       */
      .get('/api/tunnel-interfaces/:id/peers/:peerId', defineEventHandler(async (event) => {
        const id = getRouterParam(event, 'id');
        const peerId = getRouterParam(event, 'peerId');

        const manager = await InterfaceManager.getInstance();
        const peer = manager.getPeer(id, peerId);

        if (!peer) {
          throw createError({ status: 404, message: 'Peer not found' });
        }

        return { peer: peer.toJSON() };
      }))

      /**
       * PATCH /api/tunnel-interfaces/:id/peers/:peerId
       * Обновить peer
       */
      .patch('/api/tunnel-interfaces/:id/peers/:peerId', defineEventHandler(async (event) => {
        const id = getRouterParam(event, 'id');
        const peerId = getRouterParam(event, 'peerId');
        const updates = await readBody(event);

        const manager = await InterfaceManager.getInstance();
        const peer = await manager.updatePeer(id, peerId, updates);

        debug(`Peer updated: ${peerId}`);
        return { peer: peer.toJSON() };
      }))

      /**
       * DELETE /api/tunnel-interfaces/:id/peers/:peerId
       * Удалить peer
       */
      .delete('/api/tunnel-interfaces/:id/peers/:peerId', defineEventHandler(async (event) => {
        const id = getRouterParam(event, 'id');
        const peerId = getRouterParam(event, 'peerId');

        const manager = await InterfaceManager.getInstance();
        await manager.removePeer(id, peerId);

        debug(`Peer deleted: ${peerId}`);
        return { success: true };
      }))

      /**
       * GET /api/tunnel-interfaces/:id/peers/:peerId/config
       * Скачать конфиг для peer
       */
      .get('/api/tunnel-interfaces/:id/peers/:peerId/config', defineEventHandler(async (event) => {
        const id = getRouterParam(event, 'id');
        const peerId = getRouterParam(event, 'peerId');

        const manager = await InterfaceManager.getInstance();
        const config = await manager.getPeerRemoteConfig(id, peerId);
        const peer = manager.getPeer(id, peerId);
        const filename = `${peer.name.replace(/\s+/g, '-')}.conf`;

        setHeader(event, 'Content-Type', 'text/plain');
        setHeader(event, 'Content-Disposition', `attachment; filename="${filename}"`);
        return config;
      }))

      /**
       * GET /api/tunnel-interfaces/:id/peers/:peerId/qrcode.svg
       * QR-код с конфигом для peer (для мобильных клиентов AmneziaWG)
       */
      .get('/api/tunnel-interfaces/:id/peers/:peerId/qrcode.svg', defineEventHandler(async (event) => {
        const id = getRouterParam(event, 'id');
        const peerId = getRouterParam(event, 'peerId');

        const manager = await InterfaceManager.getInstance();
        const config = await manager.getPeerRemoteConfig(id, peerId);
        const svg = await QRCode.toString(config, { type: 'svg', width: 512 });

        setHeader(event, 'Content-Type', 'image/svg+xml');
        return svg;
      }))

      /**
       * POST /api/tunnel-interfaces/:id/peers/:peerId/enable
       */
      .post('/api/tunnel-interfaces/:id/peers/:peerId/enable', defineEventHandler(async (event) => {
        const id = getRouterParam(event, 'id');
        const peerId = getRouterParam(event, 'peerId');

        const manager = await InterfaceManager.getInstance();
        const peer = await manager.updatePeer(id, peerId, { enabled: true });
        return { peer: peer.toJSON() };
      }))

      /**
       * POST /api/tunnel-interfaces/:id/peers/:peerId/disable
       */
      .post('/api/tunnel-interfaces/:id/peers/:peerId/disable', defineEventHandler(async (event) => {
        const id = getRouterParam(event, 'id');
        const peerId = getRouterParam(event, 'peerId');

        const manager = await InterfaceManager.getInstance();
        const peer = await manager.updatePeer(id, peerId, { enabled: false });
        return { peer: peer.toJSON() };
      }))

      /**
       * GET /api/tunnel-interfaces/:id/peers/:peerId/export-json
       * Экспортировать параметры Interconnect peer для передачи удалённой стороне.
       *
       * Возвращает JSON-объект который удалённая сторона использует для импорта через
       * POST /api/tunnel-interfaces/:remoteId/peers/import-json.
       *
       * Поля ответа:
       *   name, publicKey, presharedKey, endpoint (WG_HOST:listenPort),
       *   persistentKeepalive, allowedIPs (туннельный IP /32), clientAllowedIPs
       *
       * Доступен только для Interconnect пиров (peerType === 'interconnect').
       */
      .get('/api/tunnel-interfaces/:id/peers/:peerId/export-json', defineEventHandler(async (event) => {
        const id = getRouterParam(event, 'id');
        const peerId = getRouterParam(event, 'peerId');

        const manager = await InterfaceManager.getInstance();
        const iface = manager.getInterface(id);
        if (!iface) {
          throw createError({ status: 404, message: 'Interface not found' });
        }

        const peer = manager.getPeer(id, peerId);
        if (!peer) {
          throw createError({ status: 404, message: 'Peer not found' });
        }

        if (peer.peerType !== 'interconnect') {
          throw createError({ status: 400, message: 'export-json is only available for interconnect peers' });
        }

        const params = iface.exportPeerParams(peerId);
        return params;
      }))

      /**
       * PUT /api/tunnel-interfaces/:id/peers/:peerId/name
       */
      .put('/api/tunnel-interfaces/:id/peers/:peerId/name', defineEventHandler(async (event) => {
        const id = getRouterParam(event, 'id');
        const peerId = getRouterParam(event, 'peerId');
        const { name } = await readBody(event);

        const manager = await InterfaceManager.getInstance();
        const peer = await manager.updatePeer(id, peerId, { name, updatedAt: new Date().toISOString() });
        return { peer: peer.toJSON() };
      }))

      /**
       * PUT /api/tunnel-interfaces/:id/peers/:peerId/address
       */
      .put('/api/tunnel-interfaces/:id/peers/:peerId/address', defineEventHandler(async (event) => {
        const id = getRouterParam(event, 'id');
        const peerId = getRouterParam(event, 'peerId');
        const { address } = await readBody(event);

        const manager = await InterfaceManager.getInstance();
        const peer = await manager.updatePeer(id, peerId, { allowedIPs: address, updatedAt: new Date().toISOString() });
        return { peer: peer.toJSON() };
      }))

      /**
       * PUT /api/tunnel-interfaces/:id/peers/:peerId/expireDate
       */
      .put('/api/tunnel-interfaces/:id/peers/:peerId/expireDate', defineEventHandler(async (event) => {
        const id = getRouterParam(event, 'id');
        const peerId = getRouterParam(event, 'peerId');
        const { expireDate } = await readBody(event);

        const manager = await InterfaceManager.getInstance();
        const expiredAt = expireDate ? new Date(expireDate).toISOString() : null;
        const peer = await manager.updatePeer(id, peerId, { expiredAt, updatedAt: new Date().toISOString() });
        return { peer: peer.toJSON() };
      }))

      /**
       * POST /api/tunnel-interfaces/:id/peers/:peerId/generateOneTimeLink
       */
      .post('/api/tunnel-interfaces/:id/peers/:peerId/generateOneTimeLink', defineEventHandler(async (event) => {
        const id = getRouterParam(event, 'id');
        const peerId = getRouterParam(event, 'peerId');

        const manager = await InterfaceManager.getInstance();
        const oneTimeLink = [crypto.randomBytes(16).toString('hex')].join('');
        const peer = await manager.updatePeer(id, peerId, { oneTimeLink });
        return { peer: peer.toJSON() };
      }))

      /**
       * GET /api/tunnel-interfaces/:id/export-obfuscation
       * Экспортировать AWG2 параметры обфускации интерфейса.
       *
       * Возвращает текущие AWG2 параметры (Jc, Jmin, Jmax, S1-S4, H1-H4, I1-I5)
       * в формате совместимом с Settings.createTemplate() — можно сохранить как профиль.
       * H1-H4 копируются как есть (диапазоны), рандомизацию делает AWG-протокол.
       *
       * Ошибка 400 если интерфейс не AWG2.
       */
      .get('/api/tunnel-interfaces/:id/export-obfuscation', defineEventHandler(async (event) => {
        const id = getRouterParam(event, 'id');
        const manager = await InterfaceManager.getInstance();
        const iface = manager.getInterface(id);
        if (!iface) {
          throw createError({ status: 404, message: 'Interface not found' });
        }

        let params;
        try {
          params = iface.exportObfuscationParams();
        } catch (err) {
          throw createError({ status: 400, message: err.message });
        }

        return params;
      }))

      /**
       * GET /api/tunnel-interfaces/:id/backup
       * Download interface + peers as JSON
       */
      .get('/api/tunnel-interfaces/:id/backup', defineEventHandler(async (event) => {
        const id = getRouterParam(event, 'id');
        const manager = await InterfaceManager.getInstance();
        const iface = manager.getInterface(id);
        if (!iface) {
          throw createError({ status: 404, message: 'Interface not found' });
        }

        const backup = {
          interface: iface.data,
          peers: iface.getAllPeers().map(p => p.toJSON()),
        };

        setHeader(event, 'Content-Disposition', `attachment; filename="${id}.json"`);
        setHeader(event, 'Content-Type', 'application/json');
        return backup;
      }))

      /**
       * PUT /api/tunnel-interfaces/:id/restore
       * Restore interface peers from JSON backup
       */
      .put('/api/tunnel-interfaces/:id/restore', defineEventHandler(async (event) => {
        const id = getRouterParam(event, 'id');
        const { file } = await readBody(event);

        if (!file || !file.peers) {
          throw createError({ status: 400, message: 'Invalid backup file (missing peers array)' });
        }

        const manager = await InterfaceManager.getInstance();
        const iface = manager.getInterface(id);
        if (!iface) {
          throw createError({ status: 404, message: 'Interface not found' });
        }

        // Remove all existing peers
        for (const peerId of Array.from(iface.peers.keys())) {
          await iface.removePeer(peerId);
        }

        // Add peers from backup
        for (const peerData of file.peers) {
          delete peerData.interfaceId; // Will be set by addPeer
          await iface.addPeer(peerData);
        }

        debug(`Interface ${id} restored with ${file.peers.length} peers`);
        return { interface: iface.toJSON() };
      }))

      // ========================================================================
      // Settings API
      // ========================================================================

      /**
       * GET /api/settings
       * Получить глобальные настройки
       */
      .get('/api/settings', defineEventHandler(async () => {
        const settings = await Settings.getInstance();
        return settings.getSettings();
      }))

      /**
       * PUT /api/settings
       * Обновить глобальные настройки
       * Body: { dns?, defaultPersistentKeepalive?, defaultClientAllowedIPs? }
       */
      .put('/api/settings', defineEventHandler(async (event) => {
        const updates = await readBody(event);
        const settings = await Settings.getInstance();
        const updated = await settings.updateSettings(updates);
        debug('Settings updated');
        return updated;
      }))

      // ========================================================================
      // AWG2 Templates API
      // ========================================================================

      /**
       * GET /api/templates
       * Получить список шаблонов AWG2
       */
      .get('/api/templates', defineEventHandler(async () => {
        const settings = await Settings.getInstance();
        return { templates: settings.getTemplates() };
      }))

      /**
       * POST /api/templates
       * Создать новый шаблон
       * Body: { name, isDefault?, jc, jmin, jmax, s1-s4, h1-h4, i1-i5 }
       */
      .post('/api/templates', defineEventHandler(async (event) => {
        const body = await readBody(event);
        if (!body.name) {
          throw createError({ status: 400, message: 'Template name is required' });
        }
        const settings = await Settings.getInstance();
        const template = await settings.createTemplate(body);
        debug(`Template created: ${template.id}`);
        return { template };
      }))

      /**
       * GET /api/templates/:id
       * Получить шаблон по ID
       */
      .get('/api/templates/:id', defineEventHandler(async (event) => {
        const id = getRouterParam(event, 'id');
        const settings = await Settings.getInstance();
        const template = settings.getTemplate(id);
        if (!template) {
          throw createError({ status: 404, message: 'Template not found' });
        }
        return { template };
      }))

      /**
       * PUT /api/templates/:id
       * Обновить шаблон
       */
      .put('/api/templates/:id', defineEventHandler(async (event) => {
        const id = getRouterParam(event, 'id');
        const updates = await readBody(event);
        const settings = await Settings.getInstance();
        const template = await settings.updateTemplate(id, updates);
        debug(`Template updated: ${id}`);
        return { template };
      }))

      /**
       * DELETE /api/templates/:id
       * Удалить шаблон
       */
      .delete('/api/templates/:id', defineEventHandler(async (event) => {
        const id = getRouterParam(event, 'id');
        const settings = await Settings.getInstance();
        await settings.deleteTemplate(id);
        debug(`Template deleted: ${id}`);
        return { success: true };
      }))

      /**
       * POST /api/templates/:id/set-default
       * Пометить шаблон как дефолтный
       */
      .post('/api/templates/:id/set-default', defineEventHandler(async (event) => {
        const id = getRouterParam(event, 'id');
        const settings = await Settings.getInstance();
        const template = await settings.setDefaultTemplate(id);
        debug(`Template set as default: ${id}`);
        return { template };
      }))

      /**
       * POST /api/templates/:id/apply
       * Получить AWG2 параметры шаблона с рандомизированными H1-H4
       * Используется UI при выборе шаблона для нового Instance
       */
      .post('/api/templates/:id/apply', defineEventHandler(async (event) => {
        const id = getRouterParam(event, 'id');
        const settings = await Settings.getInstance();
        const awgSettings = settings.applyTemplate(id);
        return { settings: awgSettings };
      }));

    const safePathJoin = (base, target) => {
      // Manage web root (edge case)
      if (target === '/') {
        return `${base}${sep}`;
      }

      // Prepend './' to prevent absolute paths
      const targetPath = `.${sep}${target}`;

      // Resolve the absolute path
      const resolvedPath = resolve(base, targetPath);

      // Check if resolvedPath is a subpath of base
      if (resolvedPath.startsWith(`${base}${sep}`)) {
        return resolvedPath;
      }

      throw createError({
        status: 400,
        message: 'Bad Request',
      });
    };

    // Check Prometheus credentials
    app.use(
      fromNodeMiddleware((req, res, next) => {
        if (!requiresPrometheusPassword || !req.url.startsWith('/metrics')) {
          return next();
        }
        const user = basicAuth(req);
        if (!user) {
          res.statusCode = 401;
          return { error: 'Not Logged In' };
        }
        if (user.pass) {
          if (isPasswordValid(user.pass, PROMETHEUS_METRICS_PASSWORD)) {
            return next();
          }
          res.statusCode = 401;
          return { error: 'Incorrect Password' };
        }
        res.statusCode = 401;
        return { error: 'Not Logged In' };
      }),
    );

    // Prometheus Metrics API
    const routerPrometheusMetrics = createRouter();
    app.use(routerPrometheusMetrics);

    // Prometheus Routes
    routerPrometheusMetrics
      .get('/metrics', defineEventHandler(async (event) => {
        setHeader(event, 'Content-Type', 'text/plain');
        if (ENABLE_PROMETHEUS_METRICS === 'true') {
          return WireGuard.getMetrics();
        }
        return '';
      }))
      .get('/metrics/json', defineEventHandler(async (event) => {
        setHeader(event, 'Content-Type', 'application/json');
        if (ENABLE_PROMETHEUS_METRICS === 'true') {
          return WireGuard.getMetricsJSON();
        }
        return '';
      }));

    // backup_restore
    const router3 = createRouter();
    app.use(router3);

    router3
      .get('/api/wireguard/backup', defineEventHandler(async (event) => {
        const config = await WireGuard.backupConfiguration();
        setHeader(event, 'Content-Disposition', 'attachment; filename="wg0.json"');
        setHeader(event, 'Content-Type', 'text/json');
        return config;
      }))
      .put('/api/wireguard/restore', defineEventHandler(async (event) => {
        const { file } = await readBody(event);
        await WireGuard.restoreConfiguration(file);
        return { success: true };
      }));

    // Static assets
    const publicDir = '/app/www';
    app.use(
      defineEventHandler((event) => {
        return serveStatic(event, {
          getContents: (id) => {
            return readFile(safePathJoin(publicDir, id));
          },
          getMeta: async (id) => {
            const filePath = safePathJoin(publicDir, id);

            const stats = await stat(filePath).catch(() => {});
            if (!stats || !stats.isFile()) {
              return;
            }

            if (id.endsWith('.html')) setHeader(event, 'Content-Type', 'text/html');
            if (id.endsWith('.js')) setHeader(event, 'Content-Type', 'application/javascript');
            if (id.endsWith('.json')) setHeader(event, 'Content-Type', 'application/json');
            if (id.endsWith('.css')) setHeader(event, 'Content-Type', 'text/css');
            if (id.endsWith('.png')) setHeader(event, 'Content-Type', 'image/png');
            if (id.endsWith('.svg')) setHeader(event, 'Content-Type', 'image/svg+xml');

            return {
              size: stats.size,
              mtime: stats.mtimeMs,
            };
          },
        });
      }),
    );

    // ========================================================================
    // Initialize Settings (async initialization)
    // ========================================================================
    Settings.getInstance().then(() => {
      debug('Settings initialized successfully');
    }).catch((err) => {
      debug('Error initializing Settings:', err);
    });

    // ========================================================================
    // Initialize TunnelManager (async initialization)
    // ========================================================================
    this.tunnelManager.init().then(() => {
      debug('TunnelManager initialized successfully');
    }).catch((err) => {
      debug('Error initializing TunnelManager:', err);
    });

    // ========================================================================
    // Initialize InterfaceManager (async: loads + auto-starts enabled interfaces)
    // Must be called explicitly at startup — getInstance() is lazy otherwise,
    // so user tunnel interfaces would only start after the first API request.
    // ========================================================================
    InterfaceManager.getInstance().then(() => {
      debug('InterfaceManager initialized successfully');
    }).catch((err) => {
      debug('Error initializing InterfaceManager:', err);
    });

    createServer(toNodeListener(app)).listen(PORT, WEBUI_HOST);
    debug(`Listening on http://${WEBUI_HOST}:${PORT}`);

    cronJobEveryMinute();
  }

};
