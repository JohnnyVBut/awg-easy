'use strict';

const https = require('https');
const fs = require('fs');
const debug = require('debug')('PrefixFetcher');

const COUNTRY_API = 'https://stat.ripe.net/data/country-resource-list/data.json';
const ASN_API = 'https://stat.ripe.net/data/announced-prefixes/data.json';

/**
 * Pure Node.js replacement for prefixes.py.
 * Fetches IPv4 prefixes from RIPEstat (country / ASN / ASN-list),
 * deduplicates, sorts, and writes to a file.
 * No python3 dependency.
 */
class PrefixFetcher {
  /**
   * Fetch prefixes for a country code (e.g. 'RU').
   * @param {string} country
   * @param {number} timeout  ms
   * @returns {Promise<string[]>} CIDR list
   */
  static async fetchCountry(country, timeout = 60000) {
    const cc = country.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc)) throw new Error(`Invalid country code: ${country}`);
    const url = `${COUNTRY_API}?resource=${cc}&v4_format=prefix`;
    debug(`Fetching country ${cc} from ${url}`);
    const data = await PrefixFetcher._fetchJson(url, timeout);
    const entries = data?.data?.resources?.ipv4;
    if (!Array.isArray(entries)) throw new Error(`No IPv4 data for country ${cc}`);
    return PrefixFetcher._processEntries(entries);
  }

  /**
   * Fetch prefixes for a single ASN (e.g. 'AS12345' or 12345).
   * @param {string|number} asn
   * @param {number} timeout
   * @returns {Promise<string[]>}
   */
  static async fetchAsn(asn, timeout = 60000) {
    const normalized = PrefixFetcher._normalizeAsn(asn);
    const url = `${ASN_API}?resource=${normalized}`;
    debug(`Fetching ASN ${normalized} from ${url}`);
    const data = await PrefixFetcher._fetchJson(url, timeout);
    const prefixes = data?.data?.prefixes;
    if (!Array.isArray(prefixes)) throw new Error(`No prefixes data for ${normalized}`);
    // Each entry: { prefix: "1.2.3.0/24", ... } — keep IPv4 only
    const entries = prefixes.map(p => p.prefix).filter(p => p && !p.includes(':'));
    return PrefixFetcher._processEntries(entries);
  }

  /**
   * Fetch prefixes for a comma-separated ASN list.
   * @param {string} asnList  e.g. "12345,20485,3216"
   * @param {number} timeout
   * @returns {Promise<string[]>}
   */
  static async fetchAsnList(asnList, timeout = 60000) {
    const asns = asnList.split(',').map(a => a.trim()).filter(Boolean);
    if (!asns.length) throw new Error('ASN list is empty');
    const all = [];
    for (const asn of asns) {
      debug(`  ASN ${asn}...`);
      const entries = await PrefixFetcher.fetchAsn(asn, timeout);
      all.push(...entries);
      debug(`  ${asn}: ${entries.length} prefixes`);
    }
    return PrefixFetcher._deduplicateAndSort(all);
  }

  /**
   * Write prefixes to file (one CIDR per line).
   */
  static async writeToFile(prefixes, filePath) {
    const content = prefixes.join('\n') + (prefixes.length ? '\n' : '');
    await fs.promises.writeFile(filePath, content, 'utf8');
    debug(`Wrote ${prefixes.length} prefixes to ${filePath}`);
  }

  // ── private ──────────────────────────────────────────────────────────────

  static _normalizeAsn(asn) {
    const s = String(asn).trim().toUpperCase();
    return s.startsWith('AS') ? s : `AS${s}`;
  }

  static _processEntries(entries) {
    const cidrs = [];
    for (const entry of entries) {
      const e = String(entry || '').trim();
      if (!e) continue;
      if (e.includes('-')) {
        // IP range → expand to CIDRs
        cidrs.push(...PrefixFetcher._rangeToSidrs(e));
      } else if (e.includes('/')) {
        const normalized = PrefixFetcher._normalizeCidr(e);
        if (normalized) cidrs.push(normalized);
      }
    }
    return PrefixFetcher._deduplicateAndSort(cidrs);
  }

  static _deduplicateAndSort(cidrs) {
    const seen = new Set();
    const valid = [];
    for (const cidr of cidrs) {
      if (cidr && !seen.has(cidr)) {
        seen.add(cidr);
        valid.push(cidr);
      }
    }
    valid.sort((a, b) => {
      const aNum = PrefixFetcher._ipToNum(a.split('/')[0]);
      const bNum = PrefixFetcher._ipToNum(b.split('/')[0]);
      if (aNum !== bNum) return aNum < bNum ? -1 : 1;
      return parseInt(a.split('/')[1], 10) - parseInt(b.split('/')[1], 10);
    });
    return valid;
  }

  /**
   * Normalise a CIDR: mask off host bits, validate.
   * Returns null if invalid (IPv6 included).
   */
  static _normalizeCidr(cidr) {
    try {
      const slash = cidr.indexOf('/');
      if (slash === -1) return null;
      const ip = cidr.slice(0, slash);
      const pfx = parseInt(cidr.slice(slash + 1), 10);
      if (isNaN(pfx) || pfx < 0 || pfx > 32) return null;
      if (ip.includes(':')) return null; // skip IPv6
      const parts = ip.split('.');
      if (parts.length !== 4) return null;
      for (const p of parts) {
        const n = parseInt(p, 10);
        if (isNaN(n) || n < 0 || n > 255 || String(n) !== p) return null;
      }
      const num = PrefixFetcher._ipToNum(ip);
      const mask = pfx === 0 ? 0 : (0xFFFFFFFF << (32 - pfx)) >>> 0;
      const masked = (num & mask) >>> 0;
      return `${PrefixFetcher._numToIp(masked)}/${pfx}`;
    } catch (_) {
      return null;
    }
  }

  static _ipToNum(ip) {
    const parts = ip.split('.');
    return ((parseInt(parts[0], 10) << 24) |
            (parseInt(parts[1], 10) << 16) |
            (parseInt(parts[2], 10) << 8)  |
             parseInt(parts[3], 10)) >>> 0;
  }

  static _numToIp(num) {
    return [
      (num >>> 24) & 0xFF,
      (num >>> 16) & 0xFF,
      (num >>> 8)  & 0xFF,
       num         & 0xFF,
    ].join('.');
  }

  /**
   * Expand an IP range (e.g. "1.0.0.0-1.0.0.255") to minimal CIDRs.
   * Equivalent to Python's ipaddress.summarize_address_range.
   */
  static _rangeToSidrs(range) {
    const parts = range.split('-');
    if (parts.length !== 2) return [];
    const startNum = PrefixFetcher._ipToNum(parts[0].trim());
    const endNum   = PrefixFetcher._ipToNum(parts[1].trim());
    if (startNum > endNum) return [];
    return PrefixFetcher._summarizeRange(startNum, endNum);
  }

  static _summarizeRange(startNum, endNum) {
    const cidrs = [];
    let cur = startNum;
    while (cur <= endNum) {
      // Find the largest block aligned at cur that fits within [cur, endNum]
      let pfx = 32;
      while (pfx > 0) {
        const candidate = pfx - 1;
        if (candidate === 0) break; // /0 = 0.0.0.0/0 — don't go that broad
        const blockSize = 1 << (32 - candidate); // 2^(32-pfx)
        const mask = (0xFFFFFFFF << (32 - candidate)) >>> 0;
        // The block must be aligned (cur starts on a block boundary)
        // AND the block must fit entirely within [cur, endNum]
        if ((cur & mask) === cur && (cur + blockSize - 1) >>> 0 <= endNum) {
          pfx = candidate;
        } else {
          break;
        }
      }
      const blockSize = 1 << (32 - pfx);
      cidrs.push(`${PrefixFetcher._numToIp(cur)}/${pfx}`);
      cur = (cur + blockSize) >>> 0;
      if (cur === 0) break; // wrapped around
    }
    return cidrs;
  }

  static _fetchJson(url, timeout) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: { 'User-Agent': 'awg-easy/2.0 (PrefixFetcher)' },
        timeout,
      }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`Invalid JSON from ${url}: ${e.message}`));
          }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request timed out: ${url}`));
      });
    });
  }
}

module.exports = PrefixFetcher;
