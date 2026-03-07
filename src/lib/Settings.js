'use strict';

const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const debug = require('debug')('awg:Settings');

const DEFAULTS = {
  dns: '1.1.1.1, 8.8.8.8',
  defaultPersistentKeepalive: 25,
  defaultClientAllowedIPs: '0.0.0.0/0, ::/0',
  templates: [],
};

/**
 * Generates 4 non-overlapping random H1-H4 ranges in the uint32 space.
 * Each range spans ~50 M values within one of 4 equal zones.
 * Format: "start-end" (awg-quick picks a fresh value per handshake).
 */
function generateRandomHRanges() {
  const RANGE_SIZE = 50_000_000;
  const ZONE_SIZE = Math.floor((0xFFFFFFFF - 5) / 4);
  const randRange = (zone) => {
    const zoneStart = 5 + zone * ZONE_SIZE;
    const zoneEnd = zoneStart + ZONE_SIZE - 1;
    const start = zoneStart + Math.floor(Math.random() * (zoneEnd - zoneStart - RANGE_SIZE));
    return `${start}-${start + RANGE_SIZE}`;
  };
  return {
    h1: randRange(0),
    h2: randRange(1),
    h3: randRange(2),
    h4: randRange(3),
  };
}

class Settings {
  constructor() {
    this.dataDir = '/etc/wireguard/data';
    this.settingsFile = `${this.dataDir}/settings.json`;
    this.data = { ...DEFAULTS, templates: [] };
  }

  async init() {
    try {
      const raw = await fs.readFile(this.settingsFile, 'utf8');
      const saved = JSON.parse(raw);
      this.data = {
        ...DEFAULTS,
        ...saved,
        templates: saved.templates || [],
      };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      // File doesn't exist — use defaults and save
      await this._save();
    }
    debug('Settings initialized');
  }

  async _save() {
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.writeFile(this.settingsFile, JSON.stringify(this.data, null, 2));
  }

  // ============================================================
  // Global Settings
  // ============================================================

  getSettings() {
    return {
      dns: this.data.dns,
      defaultPersistentKeepalive: this.data.defaultPersistentKeepalive,
      defaultClientAllowedIPs: this.data.defaultClientAllowedIPs,
    };
  }

  async updateSettings(updates) {
    if (updates.dns !== undefined) this.data.dns = String(updates.dns);
    if (updates.defaultPersistentKeepalive !== undefined) {
      this.data.defaultPersistentKeepalive = Number(updates.defaultPersistentKeepalive);
    }
    if (updates.defaultClientAllowedIPs !== undefined) {
      this.data.defaultClientAllowedIPs = String(updates.defaultClientAllowedIPs);
    }
    await this._save();
    return this.getSettings();
  }

  // ============================================================
  // AWG2 Templates
  // ============================================================

  getTemplates() {
    return this.data.templates;
  }

  getTemplate(id) {
    return this.data.templates.find((t) => t.id === id) || null;
  }

  getDefaultTemplate() {
    return this.data.templates.find((t) => t.isDefault) || null;
  }

  async createTemplate(templateData) {
    if (!templateData.name) {
      throw new Error('Template name is required');
    }

    // Имя шаблона должно быть уникальным
    const duplicate = this.data.templates.find(
      (t) => t.name.trim().toLowerCase() === templateData.name.trim().toLowerCase()
    );
    if (duplicate) {
      throw new Error(`Template with name "${templateData.name}" already exists`);
    }

    const hRanges = generateRandomHRanges();

    const template = {
      id: uuidv4(),
      name: templateData.name,
      isDefault: templateData.isDefault || false,
      jc: templateData.jc ?? 6,
      jmin: templateData.jmin ?? 10,
      jmax: templateData.jmax ?? 50,
      s1: templateData.s1 ?? 64,
      s2: templateData.s2 ?? 67,
      s3: templateData.s3 ?? 64,
      s4: templateData.s4 ?? 4,
      // H1-H4: use provided values or generate fresh random ranges
      h1: templateData.h1 || hRanges.h1,
      h2: templateData.h2 || hRanges.h2,
      h3: templateData.h3 || hRanges.h3,
      h4: templateData.h4 || hRanges.h4,
      i1: templateData.i1 || '',
      i2: templateData.i2 || '',
      i3: templateData.i3 || '',
      i4: templateData.i4 || '',
      i5: templateData.i5 || '',
      createdAt: new Date().toISOString(),
    };

    if (template.isDefault) {
      for (const t of this.data.templates) t.isDefault = false;
    }

    this.data.templates.push(template);
    await this._save();
    debug(`Template created: ${template.id} (${template.name})`);
    return template;
  }

  async updateTemplate(id, updates) {
    const idx = this.data.templates.findIndex((t) => t.id === id);
    if (idx === -1) throw new Error('Template not found');

    // Если имя меняется — проверить уникальность среди ДРУГИХ шаблонов
    if (updates.name !== undefined) {
      const duplicate = this.data.templates.find(
        (t) => t.id !== id &&
               t.name.trim().toLowerCase() === updates.name.trim().toLowerCase()
      );
      if (duplicate) {
        throw new Error(`Template with name "${updates.name}" already exists`);
      }
    }

    if (updates.isDefault) {
      for (const t of this.data.templates) t.isDefault = false;
    }

    Object.assign(this.data.templates[idx], updates);
    await this._save();
    debug(`Template updated: ${id}`);
    return this.data.templates[idx];
  }

  async deleteTemplate(id) {
    const idx = this.data.templates.findIndex((t) => t.id === id);
    if (idx === -1) throw new Error('Template not found');
    this.data.templates.splice(idx, 1);
    await this._save();
    debug(`Template deleted: ${id}`);
  }

  /**
   * Mark a template as default (unsets all others).
   */
  async setDefaultTemplate(id) {
    const template = this.data.templates.find((t) => t.id === id);
    if (!template) throw new Error('Template not found');
    for (const t of this.data.templates) t.isDefault = false;
    template.isDefault = true;
    await this._save();
    debug(`Template set as default: ${id}`);
    return template;
  }

  /**
   * Returns the settings that a new instance should inherit.
   * Used by InterfaceManager when creating a peer to fill in defaults.
   */
  getPeerDefaults() {
    return {
      dns: this.data.dns,
      persistentKeepalive: this.data.defaultPersistentKeepalive,
      clientAllowedIPs: this.data.defaultClientAllowedIPs,
    };
  }

  /**
   * Returns the default template's AWG2 settings copied as-is (including H1-H4 ranges).
   * Returns null if no default template exists.
   */
  applyDefaultTemplate() {
    const tmpl = this.getDefaultTemplate();
    if (!tmpl) return null;
    return this._applyTemplate(tmpl);
  }

  /**
   * Returns a named template's AWG2 settings copied as-is (including H1-H4 ranges).
   */
  applyTemplate(id) {
    const tmpl = this.getTemplate(id);
    if (!tmpl) throw new Error('Template not found');
    return this._applyTemplate(tmpl);
  }

  _applyTemplate(tmpl) {
    // H1-H4 are copied exactly from the template.
    // Both sides of the tunnel MUST use identical ranges — the AWG protocol
    // itself picks a random value within the range on each handshake.
    // Do NOT randomise here.
    return {
      jc: tmpl.jc,
      jmin: tmpl.jmin,
      jmax: tmpl.jmax,
      s1: tmpl.s1,
      s2: tmpl.s2,
      s3: tmpl.s3,
      s4: tmpl.s4,
      h1: tmpl.h1,
      h2: tmpl.h2,
      h3: tmpl.h3,
      h4: tmpl.h4,
      i1: tmpl.i1,
      i2: tmpl.i2,
      i3: tmpl.i3,
      i4: tmpl.i4,
      i5: tmpl.i5,
    };
  }
}

// Singleton
let instance = null;

module.exports = {
  getInstance: async () => {
    if (!instance) {
      instance = new Settings();
      await instance.init();
    }
    return instance;
  },
};
