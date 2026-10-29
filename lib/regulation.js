'use strict';

/**
 * Regulation of the stove towards a comfort target.
 *
 * Modes (app setting « regulation.mode »):
 *   flows    – the app controls nothing; Flows switch the thermostat (default).
 *   netatmo  – compensated setpoint: while a comfort target is held (« Hold [21] °C »), the app sets
 *              the thermostat setpoint so that the comfort room, not the hall where the thermostat
 *              is, reaches the target. The setpoint is the target minus the learnt comfort/thermostat
 *              gap, limited to ± maxOffset and rounded to 0.5 °C, updated at most every 10 minutes.
 *   direct   – the app switches the stove itself (write commands) with a hysteresis on the comfort
 *              temperature; the thermostat is set to a high manual setpoint so that its relay stays
 *              closed. On loss of the stove connection or of the comfort sensor, the thermostat goes
 *              back to its schedule (fallback).
 *
 * Automatic power (option, needs the write commands): while a target is held and the stove heats,
 * power = 1 + 2 × (target − comfort), limited to [minPower, maxPower], changed at most every 10 min.
 */

const MIN = 60 * 1000;

const DEFAULTS = Object.freeze({
  mode: 'flows',
  thermostatId: null,
  maxOffset: 1.5,
  updateMinutes: 10,
  hysteresisLow: 0.3,
  hysteresisHigh: 0.2,
  directHoldSetpoint: 28,
  gapAlpha: 0.1,
  autoPower: false,
  minPower: 1,
  maxPower: 5,
});

const round05 = (v) => Math.round(v * 2) / 2;

class Regulator {

  constructor({ store, now = Date.now, log = () => {} }) {
    this.store = store;
    this.now = now;
    this.log = log;
    this.state = { gap: null, lastSetpoint: null, lastWrite: 0, stoveOn: null, fallback: false, ...(store.get('regulation_state') || {}) };
  }

  config() {
    return { ...DEFAULTS, ...(this.store.get('regulation') || {}) };
  }

  _save() {
    this.store.set('regulation_state', this.state);
  }

  hold() {
    return this.store.get('regulation_hold') || null;
  }

  /** « Hold [t] °C in the comfort room » (until « Stop holding »). */
  setHold(target) {
    const t = Number(target);
    if (!(t >= 5 && t <= 28)) throw new Error(`Invalid target: ${target}`);
    this.store.set('regulation_hold', { target: t, since: this.now() });
    this.state.lastWrite = 0; // apply at once
    this._save();
  }

  clearHold() {
    this.store.set('regulation_hold', null);
    this.state.lastSetpoint = null;
    this.state.stoveOn = null;
    this._save();
  }

  /** Smoothed comfort − thermostat gap (sun or a cold hall make it vary during the day). */
  observeGap(comfort, regulation) {
    if (comfort == null || regulation == null) return this.state.gap;
    const g = comfort - regulation;
    const a = this.config().gapAlpha;
    this.state.gap = this.state.gap == null ? g : this.state.gap + a * (g - this.state.gap);
    return this.state.gap;
  }

  /** Thermostat setpoint for a comfort target in netatmo mode. */
  compensatedSetpoint(target) {
    const cfg = this.config();
    const gap = this.state.gap ?? 0;
    const offset = Math.max(-cfg.maxOffset, Math.min(cfg.maxOffset, gap));
    return round05(target - offset);
  }

  /**
   * One step (every minute). Returns the actions to perform:
   *   { type: 'setpoint', value } | { type: 'stove', on } | { type: 'schedule' } | { type: 'power', level }
   * @param {{comfort:?number, regulation:?number, thermostatTarget:?number, stoveReachable:boolean,
   *   commandsEnabled:boolean, stoveHeating:boolean, power:?number}} s
   */
  step(s) {
    const cfg = this.config();
    const hold = this.hold();
    const actions = [];
    this.observeGap(s.comfort, s.regulation);
    if (cfg.mode === 'flows' || !hold || !cfg.thermostatId) {
      if (this.state.fallback) this.state.fallback = false;
      this._save();
      return actions;
    }
    const due = this.now() - this.state.lastWrite >= cfg.updateMinutes * MIN;

    if (cfg.mode === 'netatmo') {
      const sp = this.compensatedSetpoint(hold.target);
      // the thermostat's own value wins: a manual setpoint that expired is written again
      const current = s.thermostatTarget != null ? s.thermostatTarget : this.state.lastSetpoint;
      if (sp !== current && due) {
        actions.push({ type: 'setpoint', value: sp, reason: `target ${hold.target}, gap ${this.state.gap?.toFixed(2)}` });
        this.state.lastSetpoint = sp;
        this.state.lastWrite = this.now();
      }
    }

    if (cfg.mode === 'direct') {
      const healthy = s.stoveReachable && s.commandsEnabled && s.comfort != null;
      if (!healthy) {
        if (!this.state.fallback) {
          this.state.fallback = true;
          this.state.lastSetpoint = null;
          this.state.lastWrite = 0;
          this.state.stoveOn = null;
          actions.push({ type: 'schedule', reason: !s.commandsEnabled ? 'commands disabled' : !s.stoveReachable ? 'stove unreachable' : 'comfort sensor missing' });
        }
      } else {
        this.state.fallback = false;
        const current = s.thermostatTarget != null ? s.thermostatTarget : this.state.lastSetpoint;
        if (current !== cfg.directHoldSetpoint && due) {
          actions.push({ type: 'setpoint', value: cfg.directHoldSetpoint, reason: 'keep the thermostat relay closed' });
          this.state.lastSetpoint = cfg.directHoldSetpoint;
          this.state.lastWrite = this.now();
        }
        const low = hold.target - cfg.hysteresisLow;
        const high = hold.target + cfg.hysteresisHigh;
        let want = this.state.stoveOn;
        if (s.comfort <= low) want = true;
        else if (s.comfort >= high) want = false;
        if (want != null && want !== this.state.stoveOn) {
          actions.push({ type: 'stove', on: want, reason: `comfort ${s.comfort} for ${hold.target}` });
          this.state.stoveOn = want;
        }
      }
    }
    // Automatic power: far from the target -> high power, close to it -> low power
    if (cfg.autoPower && s.commandsEnabled && s.stoveReachable && s.stoveHeating && s.comfort != null) {
      const level = Math.min(cfg.maxPower, Math.max(cfg.minPower, 1 + Math.round(2 * (hold.target - s.comfort))));
      const powerDue = this.now() - (this.state.lastPowerWrite || 0) >= cfg.updateMinutes * MIN;
      if (level !== s.power && powerDue) {
        actions.push({ type: 'power', level, reason: `comfort ${s.comfort} for ${hold.target}` });
        this.state.lastPowerWrite = this.now();
      }
    }
    this._save();
    return actions;
  }

  summary() {
    return { config: this.config(), hold: this.hold(), gap: this.state.gap == null ? null : Math.round(this.state.gap * 100) / 100, ...this.state };
  }

}

module.exports = { Regulator, DEFAULTS };
