'use strict';

const Homey = require('homey');
const { HomeyDevices } = require('./lib/homey-devices');
const { SensorHub } = require('./lib/sensors');
const { MeteoFranceForecast, valueAt } = require('./lib/forecast');
const { ThermalLearner, nextOccurrence } = require('./lib/thermal');
const { TargetPlanner } = require('./lib/targets');
const { Consumables } = require('./lib/consumables');

const ANTICIPATION_DEFAULTS = Object.freeze({ target: 21, time: '06:20', sensor: 'comfort' });

const SENSOR_INTERVAL = 60 * 1000;

class PelletStoveApp extends Homey.App {

  async onInit() {
    this.devicesApi = new HomeyDevices(this.homey);
    this.forecast = new MeteoFranceForecast({
      getLocation: () => ({
        latitude: this.homey.geolocation.getLatitude(),
        longitude: this.homey.geolocation.getLongitude(),
      }),
      store: this.homey.settings,
      log: this.log.bind(this),
    });
    this.sensors = new SensorHub({
      readDevice: (id) => this.devicesApi.readDevice(id),
      getConfig: () => this.homey.settings.get('sensors'),
      store: this.homey.settings,
      forecastProvider: this.forecast,
      log: this.log.bind(this),
    });
    this.thermal = new ThermalLearner({
      store: this.homey.settings,
      timeZone: () => this.homey.clock.getTimezone(),
      log: this.log.bind(this),
    });
    this.thermal.onNight = (night, summary) => {
      this.log(`Night heat loss ${night.date}: comfort ${night.comfort}, thermostat ${night.regulation}`);
      this.emit('heat_loss', { night, summary });
    };
    this.targets = new TargetPlanner({
      store: this.homey.settings,
      timeZone: () => this.homey.clock.getTimezone(),
    });
    this.consumables = new Consumables({
      store: this.homey.settings,
      timeZone: () => this.homey.clock.getTimezone(),
      log: this.log.bind(this),
    });
    this.stoveStatus = null;
    this.plan = null;
    this.sensors.on('update', (state) => this._onSensorState(state));
    this.sensors.on('sensor_unavailable', (e) => this.log(`Sensor ${e.role} unavailable (${e.reason})`));

    this.homey.settings.on('set', (key) => {
      if (key === 'sensors' || key === 'anticipation') this.refreshSensors();
      if (key === 'consumables_settings') this.publishConsumables();
    });
    this.sensorTimer = this.homey.setInterval(() => this.refreshSensors(), SENSOR_INTERVAL);
    this.homey.setTimeout(() => this.refreshSensors(), 5000);
    this.log('Pellet Stove Manager started');
  }

  async refreshSensors() {
    if (this.refreshing) return this.sensors.state;
    this.refreshing = true;
    try {
      return await this.sensors.refresh();
    } catch (err) {
      this.error('Sensor refresh failed:', err.message);
      return this.sensors.state;
    } finally {
      this.refreshing = false;
    }
  }

  /** Stove snapshot from the device: pellets, cleaning and maintenance counters. */
  observeStove(state) {
    try {
      this.consumables.observe({
        t: state.at || Date.now(),
        status: state.status.status,
        power: state.powerLevel,
        errorCode: state.error ? state.error.code : 0,
        hoursService: state.hoursService,
        hoursTotal: state.hoursTotal,
      });
      this.publishConsumables();
    } catch (err) {
      this.error('Consumables update failed:', err.message);
    }
  }

  /** Sends the consumables state and pending events (Flow triggers) to the device. */
  publishConsumables() {
    const outdoor = this.sensors.state ? this.sensors.state.outdoor : null;
    for (const e of this.consumables.takeEvents()) {
      this.log(`Event ${e.type}`, JSON.stringify(e.tokens));
      this.emit('consumable_event', e);
    }
    this.emit('consumables', this.consumables.summary(outdoor));
  }

  /** Called by the stove device on each poll (null when the stove is unreachable). */
  setStoveStatus(status) {
    this.stoveStatus = status;
  }

  anticipationConfig() {
    return { ...ANTICIPATION_DEFAULTS, ...(this.homey.settings.get('anticipation') || {}) };
  }

  /** Outdoor temperature expected at a time: Météo-France curve (bias-corrected) or a trend to the 6 h minimum. */
  _outdoorForecast(state) {
    const mf = state.forecastSource === 'meteofrance' && this.forecast.current();
    const acc = state.forecastAccuracy && state.forecastAccuracy.meteofrance;
    const bias = acc && acc.samples >= 24 ? acc.bias : 0;
    const now = Date.now();
    const current = state.outdoor != null ? state.outdoor : state.forecastNow;
    if (mf) {
      // anchor the forecast on the measured temperature, the gap fading out over 6 hours
      const anchor = current != null ? current - (mf.now - bias) : 0;
      return (t) => {
        const v = valueAt(mf.series, t);
        const fade = Math.max(0, 1 - (t - now) / (6 * 3600e3));
        return v == null ? current : v - bias + anchor * fade;
      };
    }
    if (current == null) return null;
    const min6h = state.forecastMin6h;
    return (t) => {
      if (min6h == null || min6h >= current) return current;
      const f = Math.min(1, Math.max(0, (t - now) / (6 * 3600e3)));
      return current + (min6h - current) * f;
    };
  }

  _onSensorState(state) {
    try {
      this.thermal.observe({
        t: state.at,
        comfort: state.comfort,
        regulation: state.regulation,
        outdoor: state.outdoor,
        stove: this.stoveStatus,
      });
      const cfg = this.anticipationConfig();
      const tz = this.homey.clock.getTimezone();
      const outdoorAt = this._outdoorForecast(state);
      const current = cfg.sensor === 'regulation' ? state.regulation : state.comfort;
      const heating = ['ignition', 'heating', 'eco'].includes(this.stoveStatus);
      const planFor = (target, at) => (outdoorAt && at && current != null
        ? this.thermal.plan({ sensor: cfg.sensor, target: Number(target), at, current, outdoorAt, heating })
        : null);

      // Targets set by Flows: raise « time to start » when due
      const { due, next } = this.targets.evaluate((t) => planFor(t.temperature, t.at));
      for (const d of due) {
        this.log(`Start due for ${d.target.temperature} °C at ${d.target.time} (needed ${d.needed})`);
        this.emit('heat_start_due', {
          target: d.target.temperature, time: d.target.time, lead: d.lead, needed: d.needed, reachable: d.reachable,
        });
      }

      // Shown plan: next Flow target, else the preview target of the settings
      this.plan = next && next.plan
        ? { ...next.plan, source: 'flow', time: next.target.time }
        : (() => {
          const p = planFor(cfg.target, nextOccurrence(cfg.time, Date.now(), tz));
          return p && { ...p, source: 'settings', time: cfg.time };
        })();
      this.emit('plan', this.plan);
      this.consumables.tick(state.outdoor);
      this.publishConsumables();
    } catch (err) {
      this.error('Anticipation failed:', err.message);
    }
  }

  /* ---- Settings page API ---- */

  async listSources() {
    return this.devicesApi.listTemperatureSources();
  }

  async getSensorStatus() {
    const state = await this.refreshSensors();
    if (!state) return null;
    const { readings, ...rest } = state;
    const roles = {};
    for (const [role, r] of Object.entries(readings)) {
      roles[role] = { ok: r.ok, reason: r.reason || null, name: r.name || null, value: r.value ?? null };
    }
    return {
      ...rest,
      roles,
      thermal: this.thermal.summary(),
      plan: this.plan,
      targets: this.targets.list(),
      insulation: this.thermal.lossSummary((this.homey.settings.get('insulation') || {}).worksDate || null),
      anticipation: this.anticipationConfig(),
      stoveStatus: this.stoveStatus,
      timeZone: this.homey.clock.getTimezone(),
      consumables: this.consumables.summary(state.outdoor),
    };
  }

  async consumablesAction(body) {
    const c = this.consumables;
    if (body.action === 'refilled') c.refilled();
    else if (body.action === 'cleaned') c.cleaned();
    else if (body.action === 'serviced') c.serviced({ date: body.date || null, note: body.note || '', cost: body.cost ?? null });
    else throw new Error('Unknown action');
    this.publishConsumables();
    return c.summary(this.sensors.state ? this.sensors.state.outdoor : null);
  }

  async resetLearning() {
    this.thermal.reset();
    return true;
  }

  async onUninit() {
    if (this.sensorTimer) this.homey.clearInterval(this.sensorTimer);
  }

}

module.exports = PelletStoveApp;
