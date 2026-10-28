'use strict';

/**
 * Temperature sensors used by the stove logic, chosen freely among all Homey devices.
 *
 * Roles:
 *   comfort        – temperature the targets refer to (e.g. living-room station), optional secondary
 *                    sensor averaged with a weight
 *   regulation     – sensor of the thermostat that drives the stove relay (e.g. Netatmo in the hall)
 *   outdoor        – reference outdoor sensor (in open air)
 *   outdoorBackup  – fallback outdoor sensor; its bias against the reference is learnt and removed
 *   forecast       – weather device: current temperature and minimum over the next 6 hours
 *
 * Every reading is checked (missing device or value, out of range, the stove's 99.9 °C "no probe"
 * value, frozen value, device switched off when requested) before being used.
 */

const { EventEmitter } = require('events');

const ROLES = ['comfort', 'comfort2', 'regulation', 'outdoor', 'outdoorBackup', 'forecast'];
const DEFAULTS = Object.freeze({ staleMinutes: 180, comfort2Weight: 0.5 });
const RANGE = { min: -30, max: 60 };
const OFFSET_ALPHA = 0.05; // learning rate of the backup sensor bias
const OFFSET_MIN_SAMPLES = 10; // samples before the learnt bias is applied

const round1 = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v);
const keyOf = (ref) => (ref ? `${ref.deviceId}/${ref.capability}` : null);

class SensorHub extends EventEmitter {

  /**
   * @param {object} opts
   * @param {function(string): Promise<object>} opts.readDevice  returns {name, capabilitiesObj}
   * @param {function(): object} opts.getConfig
   * @param {{get: function(string), set: function(string, *)}} opts.store  persistent storage
   * @param {function} [opts.now]
   */
  constructor({ readDevice, getConfig, store, now = Date.now, log = () => {} }) {
    super();
    this.readDevice = readDevice;
    this.getConfig = getConfig;
    this.store = store;
    this.now = now;
    this.log = log;
    this.state = null;
    this.roleStatus = {}; // role -> 'ok' | reason, to emit transitions only
  }

  config() {
    return { ...DEFAULTS, ...(this.getConfig() || {}) };
  }

  /** Read one configured sensor and validate it. */
  async read(ref, staleMinutes) {
    if (!ref || !ref.deviceId || !ref.capability) return { ok: false, reason: 'not_configured' };
    let device;
    try {
      device = await this.readDevice(ref.deviceId);
    } catch (err) {
      return { ok: false, reason: 'missing', error: err.message };
    }
    if (!device || !device.capabilitiesObj) return { ok: false, reason: 'missing' };
    const name = device.name;
    const cap = device.capabilitiesObj[ref.capability];
    if (!cap) return { ok: false, reason: 'no_capability', name };
    const { value } = cap;
    if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, reason: 'no_value', name };
    if (value >= 99 || value < RANGE.min || value > RANGE.max) return { ok: false, reason: 'out_of_range', name, value };
    if (ref.ignoreWhenOff && device.capabilitiesObj.onoff && device.capabilitiesObj.onoff.value === false) {
      return { ok: false, reason: 'device_off', name, value };
    }
    const updated = cap.lastUpdated ? new Date(cap.lastUpdated).getTime() : null;
    if (updated && this.now() - updated > staleMinutes * 60000) {
      return { ok: false, reason: 'stale', name, value, ageMinutes: Math.round((this.now() - updated) / 60000) };
    }
    return { ok: true, value, name, updated };
  }

  learnt() {
    return this.store.get('sensor_learning') || {};
  }

  _learnOffset(backupRef, primaryRef, backupValue, primaryValue) {
    const all = this.learnt();
    const key = `${keyOf(backupRef)}>${keyOf(primaryRef)}`;
    const cur = all.outdoorOffset && all.outdoorOffset.key === key ? all.outdoorOffset : { key, value: 0, n: 0 };
    const diff = backupValue - primaryValue;
    cur.value = cur.n === 0 ? diff : cur.value + OFFSET_ALPHA * (diff - cur.value);
    cur.n += 1;
    all.outdoorOffset = cur;
    this.store.set('sensor_learning', all);
    return cur;
  }

  _offsetFor(backupRef, primaryRef) {
    const o = this.learnt().outdoorOffset;
    const key = `${keyOf(backupRef)}>${keyOf(primaryRef)}`;
    return o && o.key === key && o.n >= OFFSET_MIN_SAMPLES ? o : null;
  }

  async refresh() {
    const cfg = this.config();
    const stale = Number(cfg.staleMinutes) || DEFAULTS.staleMinutes;
    const r = {};
    for (const role of ROLES) {
      if (role === 'forecast') continue;
      r[role] = await this.read(cfg[role], stale);
    }

    // Forecast device: current temperature and minimum over the next 6 hours, when available
    const forecast = { now: null, min6h: null, name: null };
    if (cfg.forecast && cfg.forecast.deviceId) {
      try {
        const dev = await this.readDevice(cfg.forecast.deviceId);
        const c = (dev && dev.capabilitiesObj) || {};
        const num = (x) => (x && typeof x.value === 'number' ? x.value : null);
        forecast.name = dev && dev.name;
        forecast.now = num(c.measure_temperature);
        forecast.min6h = num(c['measure_temperature.min_next_6_hours']);
      } catch (err) {
        forecast.error = err.message;
      }
    }

    // Comfort: primary, optionally averaged with a secondary sensor
    const comfort = { value: null, sources: [] };
    if (r.comfort.ok && r.comfort2.ok) {
      const w = Math.min(1, Math.max(0, Number(cfg.comfort2Weight)));
      comfort.value = r.comfort.value * (1 - w) + r.comfort2.value * w;
      comfort.sources = [r.comfort.name, r.comfort2.name];
    } else if (r.comfort.ok) {
      comfort.value = r.comfort.value;
      comfort.sources = [r.comfort.name];
    } else if (r.comfort2.ok) {
      comfort.value = r.comfort2.value;
      comfort.sources = [r.comfort2.name];
    }

    // Outdoor: reference, else bias-corrected backup, else forecast
    const outdoor = { value: null, source: null, sensor: null, corrected: false, offset: null };
    if (r.outdoor.ok && r.outdoorBackup.ok) {
      const o = this._learnOffset(cfg.outdoorBackup, cfg.outdoor, r.outdoorBackup.value, r.outdoor.value);
      outdoor.offset = { value: round1(o.value), samples: o.n };
    }
    if (r.outdoor.ok) {
      Object.assign(outdoor, { value: r.outdoor.value, source: 'reference', sensor: r.outdoor.name });
    } else if (r.outdoorBackup.ok) {
      const o = this._offsetFor(cfg.outdoorBackup, cfg.outdoor);
      Object.assign(outdoor, {
        value: o ? r.outdoorBackup.value - o.value : r.outdoorBackup.value,
        source: 'backup',
        sensor: r.outdoorBackup.name,
        corrected: !!o,
      });
    } else if (forecast.now != null) {
      Object.assign(outdoor, { value: forecast.now, source: 'forecast', sensor: forecast.name });
    }

    const regulation = r.regulation.ok ? r.regulation.value : null;
    const state = {
      at: this.now(),
      comfort: round1(comfort.value),
      comfortSources: comfort.sources,
      regulation: round1(regulation),
      regulationSensor: r.regulation.ok ? r.regulation.name : null,
      gap: comfort.value != null && regulation != null ? round1(comfort.value - regulation) : null,
      outdoor: round1(outdoor.value),
      outdoorSource: outdoor.source,
      outdoorSensor: outdoor.sensor,
      outdoorCorrected: outdoor.corrected,
      outdoorOffset: outdoor.offset,
      forecastMin6h: round1(forecast.min6h),
      roles: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.ok ? 'ok' : v.reason])),
      readings: r,
    };

    this._emitTransitions(cfg, r, state);
    this.state = state;
    this.emit('update', state);
    return state;
  }

  _emitTransitions(cfg, r, state) {
    for (const role of ['comfort', 'regulation', 'outdoor', 'outdoorBackup']) {
      if (!cfg[role] || !cfg[role].deviceId) continue; // not configured: nothing to report
      const now = r[role].ok ? 'ok' : r[role].reason;
      const before = this.roleStatus[role];
      this.roleStatus[role] = now;
      if (before === undefined || before === now) continue;
      if (now === 'ok') {
        this.emit('sensor_restored', { role, sensor: r[role].name || '' });
      } else if (before === 'ok') {
        let replacement = '';
        if (role === 'outdoor') replacement = state.outdoorSensor || '';
        if (role === 'comfort' && state.comfortSources.length) replacement = state.comfortSources.join(' + ');
        this.emit('sensor_unavailable', { role, sensor: r[role].name || cfg[role].deviceId, reason: now, replacement });
      }
    }
  }

}

module.exports = { SensorHub, ROLES, DEFAULTS };
