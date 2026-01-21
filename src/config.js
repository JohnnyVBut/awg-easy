'use strict';

const { release: { version } } = require('./package.json');

module.exports.RELEASE = version;
module.exports.PORT = process.env.PORT || '51821';
module.exports.WEBUI_HOST = process.env.WEBUI_HOST || '0.0.0.0';
module.exports.PASSWORD_HASH = process.env.PASSWORD_HASH;
module.exports.MAX_AGE = parseInt(process.env.MAX_AGE, 10) * 1000 * 60 || 0;
module.exports.WG_PATH = process.env.WG_PATH || '/etc/wireguard/';
module.exports.WG_DEVICE = process.env.WG_DEVICE || 'eth0';
module.exports.WG_HOST = process.env.WG_HOST;
module.exports.WG_PORT = process.env.WG_PORT || '51820';
module.exports.WG_CONFIG_PORT = process.env.WG_CONFIG_PORT || process.env.WG_PORT || '51820';
module.exports.WG_MTU = process.env.WG_MTU || null;
module.exports.WG_PERSISTENT_KEEPALIVE = process.env.WG_PERSISTENT_KEEPALIVE || '0';
module.exports.WG_DEFAULT_ADDRESS = process.env.WG_DEFAULT_ADDRESS || '10.8.0.x';
module.exports.WG_DEFAULT_DNS = typeof process.env.WG_DEFAULT_DNS === 'string'
  ? process.env.WG_DEFAULT_DNS
  : '1.1.1.1';
module.exports.WG_ALLOWED_IPS = process.env.WG_ALLOWED_IPS || '0.0.0.0/0, ::/0';

module.exports.WG_PRE_UP = process.env.WG_PRE_UP || '';
module.exports.WG_POST_UP = process.env.WG_POST_UP || `
iptables -t nat -A POSTROUTING -s ${module.exports.WG_DEFAULT_ADDRESS.replace('x', '0')}/24 -o ${module.exports.WG_DEVICE} -j MASQUERADE;
iptables -A INPUT -p udp -m udp --dport ${module.exports.WG_PORT} -j ACCEPT;
iptables -A FORWARD -i wg0 -j ACCEPT;
iptables -A FORWARD -o wg0 -j ACCEPT;
`.split('\n').join(' ');

module.exports.WG_PRE_DOWN = process.env.WG_PRE_DOWN || '';
module.exports.WG_POST_DOWN = process.env.WG_POST_DOWN || `
iptables -t nat -D POSTROUTING -s ${module.exports.WG_DEFAULT_ADDRESS.replace('x', '0')}/24 -o ${module.exports.WG_DEVICE} -j MASQUERADE;
iptables -D INPUT -p udp -m udp --dport ${module.exports.WG_PORT} -j ACCEPT;
iptables -D FORWARD -i wg0 -j ACCEPT;
iptables -D FORWARD -o wg0 -j ACCEPT;
`.split('\n').join(' ');
module.exports.LANG = process.env.LANG || 'en';
module.exports.UI_TRAFFIC_STATS = process.env.UI_TRAFFIC_STATS || 'false';
module.exports.UI_CHART_TYPE = process.env.UI_CHART_TYPE || 0;
module.exports.WG_ENABLE_ONE_TIME_LINKS = process.env.WG_ENABLE_ONE_TIME_LINKS || 'false';
module.exports.UI_ENABLE_SORT_CLIENTS = process.env.UI_ENABLE_SORT_CLIENTS || 'false';
module.exports.WG_ENABLE_EXPIRES_TIME = process.env.WG_ENABLE_EXPIRES_TIME || 'false';
module.exports.ENABLE_PROMETHEUS_METRICS = process.env.ENABLE_PROMETHEUS_METRICS || 'false';
module.exports.PROMETHEUS_METRICS_PASSWORD = process.env.PROMETHEUS_METRICS_PASSWORD;

module.exports.DICEBEAR_TYPE = process.env.DICEBEAR_TYPE || false;
module.exports.USE_GRAVATAR = process.env.USE_GRAVATAR || false;

const getRandomInt = (min, max) => min + Math.floor(Math.random() * (max - min));

// Generate random range for H parameters (AWG 2.0)
// Based on real AWG configs, ranges are typically smaller
const getRandomHeaderRange = () => {
  const min = getRandomInt(100_000_000, 2_000_000_000);
  const range = getRandomInt(200_000_000, 500_000_000);
  const max = Math.min(min + range, 2_147_483_647);
  return `${min}-${max}`;
};

// ============================================================================
// AmneziaWG 2.0 parameters
// ============================================================================

// Junk packet parameters (based on real AWG client config)
module.exports.JC = process.env.JC || 6;
module.exports.JMIN = process.env.JMIN || 10;
module.exports.JMAX = process.env.JMAX || 50;

// Handshake obfuscation (based on real AWG client config)
module.exports.S1 = process.env.S1 || 64;
module.exports.S2 = process.env.S2 || 67;
module.exports.S3 = process.env.S3 || 17;   // NEW in AWG 2.0
module.exports.S4 = process.env.S4 || 4;    // NEW in AWG 2.0

// Magic headers (AWG 2.0: now ranges MIN-MAX!)
module.exports.H1 = process.env.H1 || getRandomHeaderRange();
module.exports.H2 = process.env.H2 || getRandomHeaderRange();
module.exports.H3 = process.env.H3 || getRandomHeaderRange();
module.exports.H4 = process.env.H4 || getRandomHeaderRange();

// Protocol imitation packets (I1-I5)
// Format: <b 0xHEX> or empty string
// DNS packet example from real config (tickets.widget.kinopoisk.ru)
const DNS_PRESET = '<b 0x084481800001000300000000077469636b65747306776964676574096b696e6f706f69736b0272750000010001c00c0005000100000039001806776964676574077469636b6574730679616e646578c025c0390005000100000039002b1765787465726e616c2d7469636b6574732d776964676574066166697368610679616e646578036e657400c05d000100010000001c000457fafe25>';

module.exports.I1 = process.env.I1 || '';
module.exports.I2 = process.env.I2 || '';
module.exports.I3 = process.env.I3 || '';
module.exports.I4 = process.env.I4 || '';
module.exports.I5 = process.env.I5 || '';   // NEW in AWG 2.0

// Time between I packets (milliseconds)
module.exports.ITIME = process.env.ITIME || '0';

// DNS preset for easy activation
module.exports.DNS_PRESET = DNS_PRESET;

// AWG protocol version
module.exports.AWG_VERSION = '2.0';
