'use strict';

/**
 * AwgParamGenerator — генератор параметров обфускации AmneziaWG 2.0.
 *
 * Порт логики из AmneziaWG-Architect (JohnnyVBut/AmneziaWG-Architect).
 * Поддерживается только AWG 2.0 (H1-H4 как диапазоны, S1-S4, I1-I5).
 *
 * Профили CPS (I1):
 *   quic_initial   — QUIC Initial (RFC 9000, Long Header 0xC0-0xC3)
 *   quic_0rtt      — QUIC 0-RTT (Long Header 0xD0-0xD3)
 *   tls_client_hello — TLS 1.3 ClientHello
 *   dtls           — DTLS 1.2 ClientHello
 *   http3          — HTTP/3 over QUIC
 *   sip            — SIP REGISTER request (ASCII)
 *   wireguard_noise — WireGuard Noise_IK handshake initiation
 *   random         — случайный из вышеперечисленных
 */

const crypto = require('crypto');

// ── Host pools (сокращённые, достаточные для генерации SNI) ──────────────────

const HOST_POOLS = {
  quic_initial: [
    'yandex.net', 'yastatic.net', 'storage.yandexcloud.net', 'cloud.yandex.ru',
    'vk.com', 'mycdn.me', 'vk-cdn.net', 'ok.ru', 'mail.ru', 'avito.ru',
    'ozon.ru', 'wildberries.ru', 'kinopoisk.ru', 'sber.ru', 'tbank.ru',
    'github.com', 'objects.githubusercontent.com', 'cdn.jsdelivr.net',
    'steamstatic.com', 'steamcontent.com', 'wikipedia.org',
    'gcore.com', 'bunny.net', 'fastly.net', 'a248.e.akamai.net',
    'cloudfront.net', 'microsoft.com', 'icloud.com', 'apple.com',
    'hetzner.com', 'ovhcloud.com', 'tencentcs.com', 'alicdn.com',
  ],
  quic_0rtt: [
    'yandex.net', 'yastatic.net', 'vk.com', 'ok.ru', 'mail.ru',
    'avito.ru', 'ozon.ru', 'wildberries.ru', 'sber.ru', 'tbank.ru',
    'github.com', 'microsoft.com', 'apple.com', 'icloud.com',
    'gcore.com', 'fastly.net', 'akamaiedge.net', 'cloudfront.net',
  ],
  tls_client_hello: [
    'yandex.ru', 'yandex.net', 'yastatic.net', 'vk.com', 'ok.ru',
    'mail.ru', 'avito.ru', 'ozon.ru', 'wildberries.ru', 'kinopoisk.ru',
    'sber.ru', 'sberbank.ru', 'tbank.ru', 'vtb.ru', 'alfabank.ru',
    'github.com', 'gitlab.com', 'microsoft.com', 'office.com',
    'apple.com', 'icloud.com', 'steamcontent.com', 'wikipedia.org',
    'gcore.com', 'bunny.net', 'fastly.net', 'akamaiedge.net',
    'cloudfront.net', 'hetzner.com', 'ovhcloud.com',
  ],
  dtls: [
    'stun.yandex.net', 'stun1.l.google.com', 'stun2.l.google.com',
    'stun.cloudflare.com', 'stun.nextcloud.com', 'stun.sipnet.ru',
    'stun.services.mozilla.com', 'stun.voip.eutelia.it',
    'stun.ekiga.net', 'stunserver.stunprotocol.org',
    'stun.1und1.de', 'stun.t-online.de', 'stun.hetzner.de',
    'global.stun.twilio.com', 'stun.sip.us', 'stun.counterpath.net',
  ],
  sip: [
    'sip.beeline.ru', 'sip.megafon.ru', 'sip.mts.ru',
    'sipnet.ru', 'sip.zadarma.com', 'sip.onlinepbx.ru',
    'sip2.zadarma.com', 'registrar.sip.net', 'sip.bicom.com',
    'sip.antisip.com', 'proxy01.sipphone.com',
  ],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function rnd(a, b) {
  return Math.floor(Math.random() * (b - a + 1)) + a;
}

/**
 * rh(n) — n случайных байт как hex-строка (всегда чётная длина).
 * Использует crypto.randomBytes для криптографической случайности.
 */
function rh(n) {
  const bytes = Math.max(0, Math.floor(n));
  if (bytes === 0) return '';
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * hexPad(value, byteLen) — число → hex ровно byteLen байт (byteLen*2 символов).
 */
function hexPad(value, byteLen) {
  let hex = Math.floor(value).toString(16);
  while (hex.length < byteLen * 2) hex = '0' + hex;
  return hex.slice(-(byteLen * 2));
}

function assertEvenHex(hex, label) {
  if (hex.length % 2 !== 0) {
    console.warn(`[AwgParamGenerator] odd hex in ${label || '?'} len=${hex.length}`);
    hex = hex + '0';
  }
  return hex;
}

/**
 * rRange(base) — диапазон для H1-H4.
 * Формат: "start-end" где end = start + rnd(1000, 50000).
 */
function rRange(base) {
  const s = base + rnd(0, 500000);
  return `${s}-${s + rnd(1000, 50000)}`;
}

function getHost(pool, customHost) {
  if (customHost) return customHost;
  const hosts = HOST_POOLS[pool] || HOST_POOLS.tls_client_hello;
  return hosts[rnd(0, hosts.length - 1)];
}

// ── CPS Protocol generators ───────────────────────────────────────────────────

/**
 * mkQUICi — QUIC Initial (RFC 9000, Long Header 0xC0-0xC3)
 * Layout: 1B flags | 4B version | 1B dcid_len | dcid | 1B scid_len | scid
 *         | 1B token_len | token | 4B PN
 */
function mkQUICi(iv, host) {
  const dcid = rnd(8, 20);
  const scid = rnd(0, 20);
  const tokenLen = rnd(0, 1) === 0 ? 0 : rnd(8, 32);
  const sniRc = Math.min(host.length + rnd(0, 6), 64);
  const rLen = Math.min(rnd(20, 80) * iv, 500);

  const hex = assertEvenHex(
    hexPad(0xc0 | rnd(0, 3), 1) +
    '00000001' +
    hexPad(dcid, 1) + rh(dcid) +
    hexPad(scid, 1) + rh(scid) +
    hexPad(tokenLen, 1) + rh(tokenLen) +
    rh(4),
    'mkQUICi'
  );

  return `<b 0x${hex}><rc ${sniRc}><c><t><r ${rLen}>`;
}

/**
 * mkQUIC0 — QUIC 0-RTT (Long Header 0xD0-0xD3)
 */
function mkQUIC0(iv, host) {
  const dcid = rnd(8, 20);
  const scid = rnd(0, 20);
  const ticketHint = Math.min(host.length + rnd(4, 16), 48);
  const rLen = Math.min(rnd(30, 120) * iv, 600);

  const hex = assertEvenHex(
    hexPad(0xd0 | rnd(0, 3), 1) +
    '00000001' +
    hexPad(dcid, 1) + rh(dcid) +
    hexPad(scid, 1) + rh(scid) +
    rh(4),
    'mkQUIC0'
  );

  return `<b 0x${hex}><t><r ${rLen}><rc ${ticketHint}><c>`;
}

/**
 * mkTLS — TLS 1.3 ClientHello
 * Record: 16 03 01 [2B recLen] 01 [3B hsLen] 03 03 [32B random]
 */
function mkTLS(iv, host) {
  const recLen = rnd(300, 550);
  const hsLen = recLen - rnd(4, 9);
  const sniExt = 2 + 2 + 2 + 1 + 2 + host.length;
  const sniRc = Math.min(sniExt, 64);
  const rLen = Math.min(rnd(20, 60) * iv, 300);

  const hex = assertEvenHex(
    '160301' +
    hexPad(recLen, 2) +
    '01' +
    hexPad(hsLen, 3) +
    '0303' +
    rh(32),
    'mkTLS'
  );

  return `<b 0x${hex}><rc ${sniRc}><r ${rLen}><c><t>`;
}

/**
 * mkNoise — WireGuard Noise_IK Handshake Initiation
 */
function mkNoise(iv) {
  const rLen = Math.min(rnd(10, 40) * iv, 200);
  const rcLen = rnd(4, 12);

  return (
    `<b 0x01000000${rh(4)}>` +
    `<b 0x${rh(32)}>` +
    `<b 0x${rh(48)}>` +
    `<b 0x${rh(28)}>` +
    `<r ${rLen}><t><rc ${rcLen}>`
  );
}

/**
 * mkDTLS — DTLS 1.2 ClientHello
 * Record: 1B type | 2B version=0xFEFD | 2B epoch | 6B seq | 2B len | ...
 */
function mkDTLS(iv, host) {
  const fragLen = rnd(100, 300);
  const sniRc = Math.min(host.length + rnd(2, 8), 60);
  const epoch = rnd(0, 255);
  const rLen = Math.min(rnd(15, 50) * iv, 250);

  const hex = assertEvenHex(
    '16' +
    'fefd' +
    hexPad(epoch, 2) +
    rh(6) +
    hexPad(fragLen, 2) +
    '01' +
    rh(6) +
    'fefd0000' +
    rh(4) +
    rh(32),
    'mkDTLS'
  );

  return `<b 0x${hex}><rc ${sniRc}><c><t><r ${rLen}>`;
}

/**
 * mkHTTP3 — HTTP/3 over QUIC (расширенный набор типов пакетов)
 */
function mkHTTP3(iv, host) {
  const ptypes = [0xc0, 0xc1, 0xc2, 0xc3, 0xe0, 0xe1, 0xe2];
  const dcid = rnd(8, 20);
  const scid = rnd(0, 20);
  const sniLen = Math.min(host.length + 9 + rnd(0, 6), 64);
  const rLen = Math.min(rnd(30, 100) * iv, 500);

  const hex = assertEvenHex(
    hexPad(ptypes[rnd(0, ptypes.length - 1)], 1) +
    '00000001' +
    hexPad(dcid, 1) + rh(dcid) +
    hexPad(scid, 1) + rh(scid) +
    rh(4),
    'mkHTTP3'
  );

  return `<b 0x${hex}><rc ${sniLen}><r ${rLen}><c><t>`;
}

/**
 * mkSIP — SIP REGISTER request (ASCII → hex)
 * "REGISTER sip:" = 13 байт = 26 hex (всегда чётное).
 */
function mkSIP(iv, host) {
  let hostHex = '';
  for (let i = 0; i < host.length; i++) {
    hostHex += ('0' + host.charCodeAt(i).toString(16)).slice(-2);
  }

  const hex = assertEvenHex(
    '524547495354455220736970' + // "REGISTER sip"
    '3a' +                       // ":"
    hostHex +
    '20' +                       // " "
    rh(4),
    'mkSIP'
  );

  const rcVal = Math.min(host.length + rnd(8, 24) * iv, 150);
  const rLen = Math.min(rnd(5, 30) * iv, 120);

  return `<b 0x${hex}><rc ${rcVal}><c><t><r ${rLen}>`;
}

/**
 * mkEntropy — entropy пакеты для I2-I5.
 * Разные шаблоны порядка тегов для статистического разнообразия.
 */
function mkEntropy(idx, iv) {
  const rLen = Math.min(rnd(10, 40) * iv, 300);
  const rcLen = rnd(4, 12);
  const rdLen = rnd(4, 8);

  const b = iv >= 2 ? `<b 0x${rh(rnd(4, 8 * iv))}>` : '';
  const r = `<r ${rLen}>`;
  const t = `<t>`;
  const c = `<c>`;
  const rc = `<rc ${rcLen}>`;
  const rd = `<rd ${rdLen}>`;

  const patterns = [
    b + r + t + rc + c + rd,
    c + t + b + r + rc + rd,
    rc + b + r + c + t + rd,
    t + r + c + rc + b + rd,
    r + rc + b + t + c + rd,
  ];

  const res = patterns[(idx + rnd(0, 4)) % patterns.length];
  return res || '<r 10>';
}

/**
 * genI1 — диспетчер генератора I1 по профилю.
 */
function genI1(profile, iv, host) {
  const dispatch = {
    quic_initial:     () => mkQUICi(iv, host || getHost('quic_initial')),
    quic_0rtt:        () => mkQUIC0(iv, host || getHost('quic_0rtt')),
    tls_client_hello: () => mkTLS(iv, host || getHost('tls_client_hello')),
    wireguard_noise:  () => mkNoise(iv),
    dtls:             () => mkDTLS(iv, host || getHost('dtls')),
    http3:            () => mkHTTP3(iv, host || getHost('quic_initial')),
    sip:              () => mkSIP(iv, host || getHost('sip')),
  };

  if (profile === 'random') {
    const keys = Object.keys(dispatch);
    return genI1(keys[rnd(0, keys.length - 1)], iv, host);
  }

  return (dispatch[profile] || dispatch.quic_initial)();
}

// ── Main generator ────────────────────────────────────────────────────────────

/**
 * generate(options) — основная функция генерации параметров AWG 2.0.
 *
 * @param {object} options
 * @param {string} [options.profile='random']    — профиль CPS (quic_initial, quic_0rtt,
 *                                                  tls_client_hello, dtls, http3, sip,
 *                                                  wireguard_noise, random)
 * @param {string} [options.intensity='medium']  — интенсивность (low, medium, high)
 * @param {string} [options.host='']             — кастомный хост для SNI (опционально)
 * @param {number} [options.iterCount=0]         — счётчик неудачных попыток (0 = нормально)
 * @param {number} [options.jc=6]               — базовое значение Jc (0-10)
 *
 * @returns {{ jc, jmin, jmax, s1, s2, s3, s4, h1, h2, h3, h4,
 *             i1, i2, i3, i4, i5, profile, resolvedProfile }}
 */
function generate({ profile = 'random', intensity = 'medium', host = '', iterCount = 0, jc: jcInput = 6 } = {}) {
  const imap = { low: 1, medium: 2, high: 3 };
  const boost = iterCount * 5;
  const iv = (imap[intensity] || 2) + (iterCount > 3 ? 1 : 0);

  // H1-H4 — диапазоны в 4 непересекающихся зонах uint32
  const h1 = rRange(100000000);
  const h2 = rRange(1200000000);
  const h3 = rRange(2400000000);
  const h4 = rRange(3600000000);

  // S1-S4 — размеры пакетов
  let s1 = Math.min(64, rnd(15, 32) + boost);
  let s2 = Math.min(64, rnd(15, 32) + boost);
  if (s2 === s1 + 56) s2 += 1; // критичное ограничение: S1+56 ≠ S2
  const s3 = Math.min(64, rnd(8, 24) + boost);
  const s4 = Math.min(32, rnd(6, 18) + boost);

  // Jc / Jmin / Jmax
  const jc = Math.max(3, Math.min(10, jcInput + (intensity === 'high' ? 2 : 0)));
  const jmin = 64 + boost * 2;
  const jmax = Math.min(1280, 256 + iv * 150 + boost * 10);

  // Определяем реальный профиль (для random нужно знать что выбрано)
  let resolvedProfile = profile;
  if (profile === 'random') {
    const profiles = ['quic_initial', 'quic_0rtt', 'tls_client_hello',
      'dtls', 'http3', 'sip', 'wireguard_noise'];
    resolvedProfile = profiles[rnd(0, profiles.length - 1)];
  }

  const i1 = genI1(resolvedProfile, iv, host);
  const i2 = mkEntropy(1, iv);
  const i3 = mkEntropy(2, iv);
  const i4 = mkEntropy(3, iv);
  const i5 = mkEntropy(4, iv);

  return {
    jc, jmin, jmax,
    s1, s2, s3, s4,
    h1, h2, h3, h4,
    i1, i2, i3, i4, i5,
    profile: resolvedProfile,
  };
}

/**
 * PROFILES — список поддерживаемых профилей для UI.
 */
const PROFILES = [
  { id: 'random',           label: 'Random' },
  { id: 'quic_initial',     label: 'QUIC Initial' },
  { id: 'quic_0rtt',        label: 'QUIC 0-RTT' },
  { id: 'tls_client_hello', label: 'TLS 1.3' },
  { id: 'dtls',             label: 'DTLS 1.2' },
  { id: 'http3',            label: 'HTTP/3' },
  { id: 'sip',              label: 'SIP' },
  { id: 'wireguard_noise',  label: 'Noise_IK (WireGuard)' },
];

module.exports = { generate, PROFILES };
