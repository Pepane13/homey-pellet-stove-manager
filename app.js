'use strict';

const Homey = require('homey');
const { HomeyDevices } = require('./lib/homey-devices');
const { SensorHub } = require('./lib/sensors');
const { MeteoFranceForecast, valueAt } = require('./lib/forecast');
const { ThermalLearner, nextOccurrence } = require('./lib/thermal');
const { TargetPlanner } = require('./lib/targets');
const { Consumables } = require('./lib/consumables');
const { Regulator } = require('./lib/regulation');

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
    this.regulator = new Regulator({ store: this.homey.settings, log: this.log.bind(this) });
    this.stoves = new Set();
    this.stoveStatus = null;
    this.stovePower = null;
    this.plan = null;
    this.sensors.on('update', (state) => this._onSensorState(state));
    this.sensors.on('sensor_unavailable', (e) => this.log(`Sensor ${e.role} unavailable (${e.reason})`));

    this.homey.settings.on('set', (key) => {
      if (key === 'sensors' || key === 'anticipation') this.refreshSensors();
      if (key === 'consumables_settings') this.publishConsumables();
      if (key === 'regulation') this._regulate(this.sensors.state).catch((e) => this.error(e.message));
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
    this.stovePower = state.powerLevel ?? null;
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

  registerStove(device) {
    this.stoves.add(device);
  }

  unregisterStove(device) {
    this.stoves.delete(device);
  }

  /** The (single) stove device used by the regulation. */
  stove() {
    return this.stoves.values().next().value || null;
  }

  async setHold(target) {
    this.regulator.setHold(target);
    this.log(`Hold ${target} °C in the comfort room`);
    await this._regulate(this.sensors.state);
  }

  async clearHold() {
    const cfg = this.regulator.config();
    const held = this.regulator.hold();
    this.regulator.clearHold();
    this.log('Hold stopped');
    if (held && cfg.mode !== 'flows' && cfg.thermostatId) await this._backToSchedule(cfg, 'hold stopped');
  }

  async _backToSchedule(cfg, reason) {
    try {
      await this.devicesApi.runDeviceAction(cfg.thermostatId, 'thermostat_set_mode', { mode: 'schedule' });
      this.log(`Thermostat back to its schedule (${reason})`);
    } catch (err) {
      this.error('Thermostat schedule failed:', err.message);
    }
  }

  /** One regulation step: compensated setpoint (netatmo), stove switching (direct), automatic power. */
  async _regulate(state) {
    if (!state) return;
    const stove = this.stove();
    const cfg = this.regulator.config();
    let thermostatTarget = null;
    if (cfg.mode !== 'flows' && cfg.thermostatId && this.regulator.hold()) {
      try {
        const th = await this.devicesApi.readDevice(cfg.thermostatId);
        const v = th.capabilitiesObj && th.capabilitiesObj.target_temperature && th.capabilitiesObj.target_temperature.value;
        if (typeof v === 'number') thermostatTarget = v;
      } catch (err) {
        this.error('Thermostat read failed:', err.message);
      }
    }
    const actions = this.regulator.step({
      comfort: state.comfort,
      regulation: state.regulation,
      thermostatTarget,
      stoveReachable: !!stove && stove.getAvailable() && this.stoveStatus != null,
      commandsEnabled: !!stove && stove.commandsEnabled(),
      stoveHeating: !!stove && stove.isHeating(),
      power: this.stovePower,
    });
    for (const a of actions) {
      this.log(`Regulation: ${a.type} ${a.value ?? a.on ?? a.level ?? ''} (${a.reason || ''})`);
      try {
        if (a.type === 'setpoint') await this.devicesApi.setCapability(cfg.thermostatId, 'target_temperature', a.value);
        else if (a.type === 'schedule') {
          await this._backToSchedule(cfg, a.reason);
          this.emit('regulation_fallback', { reason: a.reason });
        } else if (a.type === 'stove') await (a.on ? stove.turnOn() : stove.turnOff());
        else if (a.type === 'power') await stove.setPowerLevel(a.level);
      } catch (err) {
        this.error(`Regulation ${a.type} failed:`, err.message);
      }
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
        power: this.stovePower,
      });
      const cfg = this.anticipationConfig();
      const tz = this.homey.clock.getTimezone();
      const outdoorAt = this._outdoorForecast(state);
      const current = cfg.sensor === 'regulation' ? state.regulation : state.comfort;
      const heating = ['ignition', 'heating', 'eco'].includes(this.stoveStatus);
      const planFor = (target, at) => (outdoorAt && at && current != null
        ? this.thermal.plan({
          sensor: cfg.sensor, target: Number(target), at, current, outdoorAt, heating, power: heating ? this.stovePower : null,
        })
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
    this._regulate(state).catch((err) => this.error('Regulation failed:', err.message));
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
      regulation: this.regulator.summary(),
      stove: (() => {
        const st = this.stove();
        return st ? { commandsEnabled: st.commandsEnabled(), power: this.stovePower } : null;
      })(),
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

  /** Main stove values for the dashboard widget. */
  async getWidgetData() {
    const stove = this.stove();
    const cap = (id) => (stove && stove.hasCapability(id) ? stove.getCapabilityValue(id) : null);
    const st = this.sensors.state || {};
    const c = this.consumables.summary(st.outdoor ?? null);
    const lang = this.homey.i18n.getLanguage() === 'fr' ? 'fr' : 'en';
    const status = cap('stove_status');
    return {
      lang,
      timeZone: this.homey.clock.getTimezone(),
      available: !!stove && stove.getAvailable(),
      status,
      statusText: status ? this.homey.__(`status.${status}`) : null,
      error: cap('alarm_generic') ? cap('stove_error') : null,
      power: cap('stove_power_level'),
      comfort: st.comfort ?? null,
      regulation: st.regulation ?? null,
      outdoor: st.outdoor ?? null,
      startText: cap('stove_start_time'),
      hold: this.regulator.hold(),
      pellets: {
        kgLeft: c.pellets.kgLeft, percent: c.pellets.percent, emptyAt: c.pellets.emptyAt, low: c.pellets.kgLeft <= c.config.lowKg,
      },
      month: {
        kg: c.month.kg, cost: c.month.cost, bags: c.month.bags, forecast: c.month.forecast ? c.month.forecast.bags : null,
      },
      cleaning: { hours: c.cleaning.hours, threshold: c.cleaning.threshold, due: c.cleaning.due },
      service: { nextDate: c.maintenance.nextDate, hoursLeft: c.maintenance.hoursLeft, due: c.maintenance.due },
    };
  }

  async listThermostats() {
    return this.devicesApi.listThermostats();
  }

  async regulationAction(body) {
    if (body.action === 'hold') await this.setHold(body.target);
    else if (body.action === 'stop') await this.clearHold();
    else throw new Error('Unknown action');
    return this.regulator.summary();
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
