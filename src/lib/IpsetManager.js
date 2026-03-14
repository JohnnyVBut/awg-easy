'use strict';

const fs      = require('fs').promises;
const fss     = require('fs');
const path    = require('path');
const { spawn } = require('child_process');
const Util    = require('./Util');
const debug   = require('debug')('awg:IpsetManager');

const IPSETS_DIR    = '/etc/wireguard/data/ipsets';
const PREFIXES_PY   = path.join(__dirname, '../../prefixes.py');

/**
 * IpsetManager — управление kernel ipset-ами.
 *
 * Отвечает за kernel-уровень: create / destroy / load / save / restore ipset-ов.
 * Метаданные (name, description, generatorOpts и т.д.) хранит AliasManager.
 *
 * Персистентность:
 *   /etc/wireguard/data/ipsets/<name>.save  — формат `ipset save`, восстанавливается через `ipset restore`
 *
 * Используемые команды:
 *   ipset create <name> hash:net family inet -exist
 *   ipset destroy <name>
 *   ipset restore -! < <file>          (-! = ignore errors on duplicates)
 *   ipset save <name>                  → записывается в <name>.save
 *   ipset list -n                      → список имён в ядре
 *   ipset list <name> | grep -c '^'    → количество строк (включая заголовок)
 *
 * Генерация через prefixes.py:
 *   python3 prefixes.py (-c CC | -a ASN | --asn-list ...) -o <tmpfile> --quiet
 *   Затем loadFromFile → saveSet.
 *   Долгий процесс (10-60 сек) → результат через job-систему (Map jobId → Promise).
 */
class IpsetManager {

  constructor() {
    /**
     * Активные generation jobs.
     * Map<jobId, { status:'running'|'done'|'error', entryCount?:number, error?:string }>
     */
    this._jobs = new Map();
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Инициализация: создать директорию + восстановить все сохранённые ipset-ы из .save файлов.
   */
  async init() {
    debug('Initializing IpsetManager...');
    await fs.mkdir(IPSETS_DIR, { recursive: true });
    await this.restoreAll();
    debug('IpsetManager ready');
  }

  // ─── Kernel operations ─────────────────────────────────────────────────────

  /**
   * Создать ipset в ядре (hash:net, IPv4).
   * Флаг -exist: не падать если уже существует.
   *
   * @param {string} name - Имя ipset (валидируется: [a-zA-Z0-9_-])
   */
  async createSet(name) {
    this._validateName(name);
    await Util.exec(`ipset create ${name} hash:net family inet -exist`, { timeout: 10000 });
    debug(`ipset created: ${name}`);
  }

  /**
   * Удалить ipset из ядра и стереть .save файл.
   *
   * @param {string} name
   */
  async destroySet(name) {
    this._validateName(name);
    try {
      await Util.exec(`ipset destroy ${name}`, { timeout: 10000 });
      debug(`ipset destroyed: ${name}`);
    } catch (err) {
      // Если не существовало в ядре — не критично
      debug(`ipset destroy ${name}: ${err.message}`);
    }
    // Удалить .save файл
    const savePath = this._savePath(name);
    await fs.unlink(savePath).catch(() => {});
    debug(`ipset save file removed: ${savePath}`);
  }

  /**
   * Загрузить префиксы из txt-файла (один CIDR/IP на строку) в ipset.
   * Сначала создаёт новый set с временным именем, затем атомарно заменяет через `ipset swap`.
   *
   * @param {string} name     - Имя целевого ipset
   * @param {string} filePath - Путь к txt-файлу с CIDR-ами
   * @returns {Promise<number>} - количество загруженных записей
   */
  async loadFromFile(name, filePath) {
    this._validateName(name);

    const tmpName = `${name}_tmp`;

    // Убедиться что целевой set существует
    await this.createSet(name);

    // Создать временный set
    await Util.exec(`ipset create ${tmpName} hash:net family inet -exist`, { timeout: 10000 });

    try {
      // Сгенерировать restore-команды из txt-файла
      const content = await fs.readFile(filePath, 'utf8');
      const lines   = content.split('\n').map(l => l.trim()).filter(Boolean);

      if (lines.length === 0) {
        throw new Error('Prefix file is empty');
      }

      // Построить restore-данные для временного set
      const restoreLines = [
        `create ${tmpName} hash:net family inet -exist`,
        ...lines.map(l => `add ${tmpName} ${l}`),
      ].join('\n') + '\n';

      const tmpRestorePath = `${filePath}.restore`;
      await fs.writeFile(tmpRestorePath, restoreLines);

      // Загрузить в ядро (flush tmpName + add записи)
      await Util.exec(`ipset flush ${tmpName}`, { timeout: 10000 });
      await Util.exec(`ipset restore -! < ${tmpRestorePath}`, { timeout: 120000 });
      await fs.unlink(tmpRestorePath).catch(() => {});

      // Атомарная замена: swap tmp → name (ядро меняет содержимое без прерывания трафика)
      await Util.exec(`ipset swap ${tmpName} ${name}`, { timeout: 10000 });

      debug(`ipset ${name}: loaded ${lines.length} entries from ${filePath}`);
      return lines.length;

    } finally {
      // Всегда удаляем временный set
      await Util.exec(`ipset destroy ${tmpName}`, { timeout: 10000 }).catch(() => {});
    }
  }

  /**
   * Сохранить ipset в .save файл (для восстановления после перезапуска контейнера).
   *
   * @param {string} name
   */
  async saveSet(name) {
    this._validateName(name);
    const savePath = this._savePath(name);
    // ipset save <name> пишет в stdout — перенаправляем в файл через shell
    await Util.exec(`ipset save ${name} > ${savePath}`, { timeout: 30000 });
    debug(`ipset ${name} saved to ${savePath}`);
  }

  /**
   * Восстановить один ipset из .save файла.
   *
   * @param {string} name
   */
  async restoreSet(name) {
    this._validateName(name);
    const savePath = this._savePath(name);
    try {
      await fs.access(savePath);
    } catch {
      debug(`restoreSet: no save file for ${name}, skipping`);
      return;
    }
    await Util.exec(`ipset restore -! < ${savePath}`, { timeout: 120000 });
    debug(`ipset ${name} restored from ${savePath}`);
  }

  /**
   * Восстановить все сохранённые ipset-ы из директории IPSETS_DIR.
   * Вызывается при init().
   */
  async restoreAll() {
    let files;
    try {
      files = await fs.readdir(IPSETS_DIR);
    } catch {
      return;
    }
    const saveFiles = files.filter(f => f.endsWith('.save'));
    debug(`Restoring ${saveFiles.length} ipset(s)...`);
    for (const f of saveFiles) {
      const name = f.replace('.save', '');
      try {
        await Util.exec(`ipset restore -! < ${path.join(IPSETS_DIR, f)}`, { timeout: 120000 });
        debug(`Restored ipset: ${name}`);
      } catch (err) {
        debug(`Failed to restore ipset ${name}: ${err.message}`);
      }
    }
  }

  /**
   * Подсчитать количество записей в ipset.
   *
   * @param {string} name
   * @returns {Promise<number>}
   */
  async entryCount(name) {
    this._validateName(name);
    try {
      // ipset list <name> выводит заголовок + "Members:" + список
      // Считаем строки после "Members:"
      const out = await Util.exec(`ipset list ${name}`, { log: false, timeout: 10000 });
      const lines = (out || '').split('\n');
      const membersIdx = lines.findIndex(l => l.startsWith('Members:'));
      if (membersIdx === -1) return 0;
      return lines.slice(membersIdx + 1).filter(l => l.trim()).length;
    } catch (err) {
      debug(`entryCount ${name} failed: ${err.message}`);
      return 0;
    }
  }

  /**
   * Получить список имён ipset-ов в ядре.
   *
   * @returns {Promise<string[]>}
   */
  async listKernelSets() {
    try {
      const out = await Util.exec('ipset list -n', { log: false, timeout: 10000 });
      return (out || '').split('\n').map(l => l.trim()).filter(Boolean);
    } catch (err) {
      debug(`listKernelSets failed: ${err.message}`);
      return [];
    }
  }

  // ─── Generator (prefixes.py) ───────────────────────────────────────────────

  /**
   * Запустить prefixes.py для генерации ipset из RIPEstat.
   * Возвращает jobId — для отслеживания прогресса через getJobStatus().
   *
   * Опции (одна из трёх, обязательна):
   *   { country: 'RU' }
   *   { asn: '12345' }
   *   { asnList: '12345,20485,3216' }
   *
   * @param {string} name  - Имя целевого ipset
   * @param {object} opts  - { country?, asn?, asnList? }
   * @returns {string} jobId
   */
  runGenerator(name, opts = {}) {
    this._validateName(name);

    const jobId = `${name}_${Date.now()}`;
    this._jobs.set(jobId, { status: 'running' });

    // Запуск в фоне — не блокируем event loop
    this._runGeneratorAsync(jobId, name, opts).catch(err => {
      debug(`Generator job ${jobId} crashed: ${err.message}`);
      this._jobs.set(jobId, { status: 'error', error: err.message });
    });

    debug(`Generator job started: ${jobId} for ipset "${name}"`);
    return jobId;
  }

  /**
   * Получить статус generation job.
   *
   * @param {string} jobId
   * @returns {{ status: 'running'|'done'|'error', entryCount?: number, error?: string }|null}
   */
  getJobStatus(jobId) {
    return this._jobs.get(jobId) || null;
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  async _runGeneratorAsync(jobId, name, opts) {
    const tmpFile = path.join(IPSETS_DIR, `${name}_gen_${Date.now()}.tmp`);

    try {
      // Построить аргументы prefixes.py
      const args = ['--quiet', '-o', tmpFile];
      if (opts.country)     args.push('-c', opts.country);
      else if (opts.asn)    args.push('-a', opts.asn);
      else if (opts.asnList) args.push('--asn-list', opts.asnList);
      else throw new Error('Generator opts must include country, asn, or asnList');

      debug(`Running: python3 ${PREFIXES_PY} ${args.join(' ')}`);

      // Запустить prefixes.py как дочерний процесс
      await this._spawnPython(args);

      // Загрузить результат в ipset
      const count = await this.loadFromFile(name, tmpFile);

      // Сохранить на диск
      await this.saveSet(name);

      this._jobs.set(jobId, { status: 'done', entryCount: count });
      debug(`Generator job ${jobId} done: ${count} entries in ipset "${name}"`);

    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  }

  /**
   * Запустить Python3 с prefixes.py и подождать завершения (Promise).
   * timeout: 5 минут — RU AS-list может быть долгим.
   */
  _spawnPython(args) {
    return new Promise((resolve, reject) => {
      const proc = spawn('python3', [PREFIXES_PY, ...args], {
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: 5 * 60 * 1000,
      });

      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });

      proc.on('close', code => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`prefixes.py exited with code ${code}: ${stderr.trim()}`));
        }
      });

      proc.on('error', err => reject(err));
    });
  }

  /**
   * Путь к .save файлу ipset.
   */
  _savePath(name) {
    return path.join(IPSETS_DIR, `${name}.save`);
  }

  /**
   * Валидация имени ipset: только буквы, цифры, '_', '-'.
   * Защита от shell injection.
   */
  _validateName(name) {
    if (!name || !/^[a-zA-Z][a-zA-Z0-9_-]{0,30}$/.test(name)) {
      throw new Error(`Invalid ipset name: "${name}". Use letters, digits, _ or - (max 31 chars, start with letter)`);
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let instance = null;
let instanceReady = null;

module.exports = {
  getInstance: async () => {
    if (!instance) {
      instance     = new IpsetManager();
      instanceReady = instance.init();
    }
    await instanceReady;
    return instance;
  },
};
