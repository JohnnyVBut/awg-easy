'use strict';

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const childProcess = require('child_process');
const crypto = require('crypto');
const debug = require('debug')('IpsetManager');

const DATA_DIR = '/etc/wireguard/data/ipsets';
const PREFIXES_SCRIPT = path.join(__dirname, '../../prefixes.py');

let instance = null;

/**
 * IpsetManager — manages kernel ipsets for firewall aliases.
 * Ipsets are persisted to disk (ipset save) and restored on container restart.
 */
class IpsetManager {
  constructor() {
    this._jobs = new Map(); // jobId → { status, entryCount?, error? }
    this._initialized = false;
  }

  static async getInstance() {
    if (!instance) {
      instance = new IpsetManager();
      await instance.init();
    }
    return instance;
  }

  async init() {
    if (this._initialized) return;
    this._initialized = true;
    debug('Initializing IpsetManager');

    try {
      await fs.promises.mkdir(DATA_DIR, { recursive: true });
      await this.restoreAll();
      debug('IpsetManager initialized');
    } catch (err) {
      debug('IpsetManager init error:', err.message);
    }
  }

  /**
   * Restore all saved ipsets from disk on startup.
   */
  async restoreAll() {
    let files;
    try {
      files = await fs.promises.readdir(DATA_DIR);
    } catch (err) {
      debug('restoreAll: cannot read dir:', err.message);
      return;
    }

    const saveFiles = files.filter(f => f.endsWith('.save'));
    for (const file of saveFiles) {
      const filePath = path.join(DATA_DIR, file);
      try {
        await this._exec(`ipset restore -! < ${filePath}`);
        debug(`Restored ipset from ${file}`);
      } catch (err) {
        debug(`Failed to restore ${file}: ${err.message}`);
      }
    }
  }

  /**
   * Create an ipset (idempotent via -exist).
   * @param {string} name
   */
  async createSet(name) {
    this._validateName(name);
    await this._exec(`ipset create ${name} hash:net family inet -exist`);
    debug(`Created set: ${name}`);
  }

  /**
   * Destroy an ipset and remove its save file.
   * @param {string} name
   */
  async destroySet(name) {
    this._validateName(name);
    try {
      await this._exec(`ipset destroy ${name}`);
      debug(`Destroyed set: ${name}`);
    } catch (err) {
      debug(`destroySet ${name}: ${err.message}`);
    }
    const saveFile = path.join(DATA_DIR, `${name}.save`);
    try {
      await fs.promises.unlink(saveFile);
    } catch (_) {}
  }

  /**
   * Load prefixes from a plain-text file (one CIDR per line) into an ipset.
   * Uses atomic swap: fill tmp set → swap with live set.
   * @param {string} name - target ipset name
   * @param {string} filePath - path to file with CIDRs
   * @returns {number} number of entries loaded
   */
  async loadFromFile(name, filePath) {
    this._validateName(name);
    const tmpName = `${name}_tmp`;

    try {
      // Create or recreate tmp set
      await this._exec(`ipset destroy ${tmpName} 2>/dev/null || true`);
      await this._exec(`ipset create ${tmpName} hash:net family inet -exist`);

      // Read lines and add to tmp set
      const content = await fs.promises.readFile(filePath, 'utf8');
      const lines = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

      // Build restore script for batch add (much faster than individual adds)
      const restoreLines = [`create ${tmpName} hash:net family inet -exist`];
      for (const cidr of lines) {
        restoreLines.push(`add ${tmpName} ${cidr} -exist`);
      }
      const restoreScript = restoreLines.join('\n') + '\n';

      // Write to temp file and restore
      const tmpScript = path.join(DATA_DIR, `${name}_restore.tmp`);
      await fs.promises.writeFile(tmpScript, restoreScript, 'utf8');
      await this._exec(`ipset restore -! < ${tmpScript}`);
      await fs.promises.unlink(tmpScript).catch(() => {});

      // Ensure target set exists before swap
      await this._exec(`ipset create ${name} hash:net family inet -exist`);

      // Atomic swap
      await this._exec(`ipset swap ${tmpName} ${name}`);
      await this._exec(`ipset destroy ${tmpName} 2>/dev/null || true`);

      const entryCount = lines.length;
      debug(`Loaded ${entryCount} entries into ${name}`);
      return entryCount;
    } catch (err) {
      // Cleanup on error
      await this._exec(`ipset destroy ${tmpName} 2>/dev/null || true`).catch(() => {});
      throw err;
    }
  }

  /**
   * Save an ipset to disk for persistence across container restarts.
   * @param {string} name
   */
  async saveSet(name) {
    this._validateName(name);
    const saveFile = path.join(DATA_DIR, `${name}.save`);
    await this._exec(`ipset save ${name} > ${saveFile}`);
    debug(`Saved ipset ${name} to ${saveFile}`);
  }

  /**
   * Get entry count of an ipset.
   * @param {string} name
   * @returns {number}
   */
  async getEntryCount(name) {
    try {
      const out = await this._exec(`ipset list ${name} -t 2>/dev/null`);
      const m = out.match(/Number of entries:\s*(\d+)/);
      return m ? parseInt(m[1], 10) : 0;
    } catch (_) {
      return 0;
    }
  }

  /**
   * Start an async generation job using prefixes.py.
   * @param {string} name - ipset name
   * @param {object} opts - { country?, asn?, asnList? }
   * @returns {string} jobId
   */
  runGenerator(name, opts = {}) {
    this._validateName(name);
    const jobId = crypto.randomBytes(8).toString('hex');
    this._jobs.set(jobId, { status: 'running' });
    debug(`Starting generator job ${jobId} for set ${name}`);
    this._runGeneratorAsync(jobId, name, opts).catch(err => {
      debug(`Generator job ${jobId} failed: ${err.message}`);
      this._jobs.set(jobId, { status: 'error', error: err.message });
    });
    return jobId;
  }

  /**
   * @returns {{ status: string, entryCount?: number, error?: string }}
   */
  getJobStatus(jobId) {
    return this._jobs.get(jobId) || { status: 'unknown' };
  }

  // ── private ──────────────────────────────────────────────────────────────

  async _runGeneratorAsync(jobId, name, opts) {
    const outFile = path.join(DATA_DIR, `${name}_generated.txt`);

    // Build prefixes.py arguments
    const args = ['prefixes.py', '--quiet', '-o', outFile];
    if (opts.asnList) {
      args.push('--asn-list', opts.asnList);
    } else if (opts.asn) {
      args.push('--asn', String(opts.asn));
    } else if (opts.country) {
      args.push('-c', opts.country.toUpperCase());
    } else {
      throw new Error('Generator opts must include country, asn, or asnList');
    }

    // Run prefixes.py
    debug(`Job ${jobId}: spawning python3 ${args.join(' ')}`);
    await this._spawnPython(args);

    // Load into ipset
    await this.createSet(name);
    const entryCount = await this.loadFromFile(name, outFile);
    await this.saveSet(name);

    // Cleanup temp file
    await fs.promises.unlink(outFile).catch(() => {});

    this._jobs.set(jobId, { status: 'done', entryCount });
    debug(`Job ${jobId} completed: ${entryCount} entries`);
  }

  _spawnPython(args) {
    return new Promise((resolve, reject) => {
      // Alpine Linux installs python3 at /usr/bin/python3.
      // spawn() does NOT use a shell, so PATH is not sourced.
      // We pass an explicit PATH covering common locations to ensure the binary is found.
      const python3 = process.env.PYTHON3_BIN || 'python3';
      const spawnEnv = {
        ...process.env,
        PATH: `/usr/bin:/usr/local/bin:/bin:/usr/sbin:/sbin${process.env.PATH ? ':' + process.env.PATH : ''}`,
      };

      const proc = childProcess.spawn(python3, args, {
        cwd: path.dirname(PREFIXES_SCRIPT),
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120000,
        env: spawnEnv,
      });

      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });

      proc.on('close', code => {
        if (code === 0) {
          resolve(stderr);
        } else {
          const msg = stderr.slice(-500) || `exited with code ${code}`;
          reject(new Error(`prefixes.py failed: ${msg}`));
        }
      });
      proc.on('error', (err) => {
        // ENOENT: python3 not found — try absolute path as last resort
        if (err.code === 'ENOENT' && python3 !== '/usr/bin/python3') {
          debug('python3 not found via PATH, retrying with /usr/bin/python3');
          const proc2 = childProcess.spawn('/usr/bin/python3', args, {
            cwd: path.dirname(PREFIXES_SCRIPT),
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 120000,
            env: spawnEnv,
          });
          let stderr2 = '';
          proc2.stderr.on('data', d => { stderr2 += d.toString(); });
          proc2.on('close', code2 => {
            if (code2 === 0) resolve(stderr2);
            else reject(new Error(`prefixes.py failed: ${stderr2.slice(-500) || 'exit ' + code2}`));
          });
          proc2.on('error', reject);
        } else {
          reject(err);
        }
      });
    });
  }

  async _exec(cmd) {
    return new Promise((resolve, reject) => {
      childProcess.exec(cmd, { shell: 'bash', timeout: 30000, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout);
      });
    });
  }

  _validateName(name) {
    if (!name || !/^[a-zA-Z][a-zA-Z0-9_-]{0,30}$/.test(name)) {
      throw new Error(`Invalid ipset name: ${name}`);
    }
  }
}

module.exports = IpsetManager;
