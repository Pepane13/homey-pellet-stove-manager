'use strict';

const Homey = require('homey');
const { HomeyDevices } = require('./lib/homey-devices');
const { SensorHub } = require('./lib/sensors');
const { MeteoFranceForecast, valueAt } = require('./lib/forecast');
const { ThermalLearner, nextOccurrence } = require('./lib/thermal');

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
    this.stoveStatus = null;
    this.plan = null;
    this.sensors.on('update', (state) => this._onSensorState(state));
    this.sensors.on('sensor_unavailable', (e) => this.log(`Sensor ${e.role} unavailable (${e.reason})`));

    this.homey.settings.on('set', (key) => {
      if (key === 'sensors' || key === 'anticipation') this.refreshSensors();
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
      const outdoorAt = this._outdoorForecast(state);
      const at = nextOccurrence(cfg.time, Date.now(), this.homey.clock.getTimezone());
      const current = cfg.sensor === 'regulation' ? state.regulation : state.comfort;
      this.plan = outdoorAt && at && current != null
        ? this.thermal.plan({
          sensor: cfg.sensor, target: Number(cfg.target), at, current, outdoorAt,
          heating: ['ignition', 'heating', 'eco'].includes(this.stoveStatus),
        })
        : null;
      this.emit('plan', this.plan);
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
      anticipation: this.anticipationConfig(),
      stoveStatus: this.stoveStatus,
      timeZone: this.homey.clock.getTimezone(),
    };
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
