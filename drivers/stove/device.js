'use strict';

const Homey = require('homey');
const { createConnection } = require('../../lib/connection');
const { DuepiClient } = require('../../lib/duepi/client');

const UNAVAILABLE_AFTER = 3; // consecutive failed snapshots

// Capabilities added after the first release: added to existing devices on start-up.
const LATER_CAPABILITIES = [
  'measure_temperature.comfort',
  'measure_temperature.regulation',
  'stove_comfort_gap',
  'measure_temperature.outdoor',
  'measure_temperature.forecast_min',
  'stove_outdoor_source',
  'stove_heatup_minutes',
  'stove_start_time',
  'stove_heat_loss',
  'stove_heat_loss_median',
  'stove_pellets_left',
  'stove_pellets_percent',
  'stove_pellets_empty_at',
  'stove_month_kg',
  'stove_month_cost',
  'stove_month_forecast',
  'stove_cleaning_hours',
  'stove_service_next',
  'stove_service_hours_left',
];

class StoveDevice extends Homey.Device {

  async onInit() {
    this.failures = 0;
    this.lastStatus = null;
    this.lastErrorCode = null;
    this.pollTimer = null;
    this.stopped = false;

    for (const cap of LATER_CAPABILITIES) {
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
    }

    // Temperatures come from the app-wide sensor hub (sensors chosen in the app settings)
    const { sensors } = this.homey.app;
    this._onSensors = (state) => this._applySensors(state).catch(this.error);
    this._onSensorDown = (e) => this._sensorTrigger('sensor_unavailable', e);
    this._onSensorUp = (e) => this._sensorTrigger('sensor_restored', e);
    sensors.on('update', this._onSensors);
    sensors.on('sensor_unavailable', this._onSensorDown);
    sensors.on('sensor_restored', this._onSensorUp);
    if (sensors.state) this._onSensors(sensors.state);
    this._onPlan = (plan) => this._applyPlan(plan).catch(this.error);
    this.homey.app.on('plan', this._onPlan);
    this._onStartDue = (e) => this.homey.flow.getDeviceTriggerCard('heat_start_due').trigger(this, e).catch(this.error);
    this.homey.app.on('heat_start_due', this._onStartDue);
    this._onHeatLoss = (e) => this._applyHeatLoss(e).catch(this.error);
    this.homey.app.on('heat_loss', this._onHeatLoss);
    const loss = this.homey.app.thermal.lossSummary();
    const last = loss.nights[loss.nights.length - 1];
    this._applyHeatLoss({ night: last, summary: loss }).catch(this.error);
    this._onConsumables = (c) => this._applyConsumables(c).catch(this.error);
    this._onConsumableEvent = (e) => this.homey.flow.getDeviceTriggerCard(e.type).trigger(this, e.tokens).catch(this.error);
    this.homey.app.on('consumables', this._onConsumables);
    this.homey.app.on('consumable_event', this._onConsumableEvent);
    this._applyConsumables(this.homey.app.consumables.summary()).catch(this.error);

    this._connect();
    this._schedule(2000);
    this.log(`Stove device ready (${this.getSetting('mode')})`);
  }

  _connect() {
    if (this.connection) this.connection.close();
    const config = {
      mode: this.getSetting('mode'),
      host: this.getSetting('host'),
      port: this.getSetting('port'),
      code: this.getStoreValue('code'),
    };
    this.connection = createConnection(config, this.log.bind(this));
    this.client = new DuepiClient(this.connection);
  }

  _schedule(delay) {
    this.homey.clearTimeout(this.pollTimer);
    if (this.stopped) return;
    const interval = Math.max(30, Number(this.getSetting('poll_interval')) || 60) * 1000;
    this.pollTimer = this.homey.setTimeout(() => this._poll(), delay == null ? interval : delay);
  }

  async _poll() {
    try {
      const state = await this.client.snapshot();
      await this._apply(state);
      this.homey.app.setStoveStatus(state.status.status);
      this.homey.app.observeStove(state);
      if (this.failures >= UNAVAILABLE_AFTER) this.log('Connection restored');
      this.failures = 0;
      if (!this.getAvailable()) await this.setAvailable();
    } catch (err) {
      this.failures += 1;
      this.log(`Snapshot failed (${this.failures}): ${err.message}`);
      if (this.failures === UNAVAILABLE_AFTER) {
        this.homey.app.setStoveStatus(null);
        await this.setUnavailable(this.homey.__('device.unreachable')).catch(this.error);
        await this.homey.flow.getDeviceTriggerCard('stove_connection_lost').trigger(this).catch(this.error);
      }
    } finally {
      this._schedule();
    }
  }

  async _apply(s) {
    const lang = this.homey.i18n.getLanguage() === 'fr' ? 'fr' : 'en';
    const error = s.error || { code: 0 };
    const alarm = error.code !== 0;
    const status = alarm ? 'alarm' : s.status.status;

    await this._set('stove_status', status);
    await this._set('alarm_generic', alarm);
    await this._set('stove_error', alarm ? `${error.code} – ${error[lang]}` : '—');
    await this._set('stove_power_level', s.powerLevel);
    await this._set('measure_temperature.flue_gas', s.flueGas);
    await this._set('measure_temperature.board', s.board);
    await this._set('stove_auger_speed', s.auger);
    await this._set('stove_exhaust_speed', s.exhaust);
    await this._set('stove_hours_total', s.hoursTotal);
    await this._set('stove_hours_service', s.hoursService);

    if (this.lastErrorCode !== null && error.code !== this.lastErrorCode) {
      if (alarm) {
        await this.homey.flow.getDeviceTriggerCard('stove_alarm_raised')
          .trigger(this, { code: error.code, message: error[lang] }).catch(this.error);
      } else {
        await this.homey.flow.getDeviceTriggerCard('stove_alarm_cleared').trigger(this).catch(this.error);
      }
    }
    if (this.lastStatus !== null && status !== this.lastStatus) {
      await this.homey.flow.getDeviceTriggerCard('stove_status_changed')
        .trigger(this, { status: this.homey.__(`status.${status}`) }).catch(this.error);
    }
    this.lastErrorCode = error.code;
    this.lastStatus = status;
  }

  async _applySensors(s) {
    // null clears a value whose sensor is unavailable, instead of showing a stale reading
    await this._set('measure_temperature.comfort', s.comfort, true);
    await this._set('measure_temperature.regulation', s.regulation, true);
    await this._set('stove_comfort_gap', s.gap, true);
    await this._set('measure_temperature.outdoor', s.outdoor, true);
    await this._set('measure_temperature.forecast_min', s.forecastMin6h, true);
    if (s.outdoorSource) {
      const key = s.outdoorSource === 'backup' && s.outdoorCorrected ? 'backup_corrected' : s.outdoorSource;
      await this._set('stove_outdoor_source', `${this.homey.__(`outdoor_source.${key}`)} – ${s.outdoorSensor || ''}`);
    }
  }

  async _applyConsumables(c) {
    const tz = this.homey.clock.getTimezone();
    const p = c.pellets;
    await this._set('stove_pellets_left', p.kgLeft);
    await this._set('stove_pellets_percent', p.percent);
    let empty = '—';
    if (p.emptyAt) {
      empty = new Date(p.emptyAt).toLocaleString('fr-FR', {
        weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz,
      });
    }
    await this._set('stove_pellets_empty_at', empty);
    await this._set('stove_month_kg', c.month.kg);
    await this._set('stove_month_cost', c.month.cost);
    if (c.month.forecast) await this._set('stove_month_forecast', c.month.forecast.bags);
    await this._set('stove_cleaning_hours', c.cleaning.hours);
    const m = c.maintenance;
    const [y, mo, d] = m.nextDate.split('-');
    await this._set('stove_service_next', `${d}/${mo}/${y}`);
    if (m.hoursLeft != null) await this._set('stove_service_hours_left', m.hoursLeft);
  }

  async _applyHeatLoss({ night, summary }) {
    if (night && night.comfort != null) await this._set('stove_heat_loss', night.comfort);
    if (summary && summary.recent.comfort != null) await this._set('stove_heat_loss_median', summary.recent.comfort);
  }

  async _applyPlan(plan) {
    if (!plan) {
      await this._set('stove_heatup_minutes', null, true);
      await this._set('stove_start_time', '—');
      return;
    }
    await this._set('stove_heatup_minutes', plan.needed ? plan.minutes : 0);
    let text;
    if (!plan.needed) {
      text = this.homey.__('plan.not_needed', { target: plan.target });
    } else {
      const time = new Date(plan.startAt).toLocaleTimeString('fr-FR', {
        hour: '2-digit', minute: '2-digit', timeZone: this.homey.clock.getTimezone(),
      });
      text = this.homey.__(plan.reachable ? 'plan.start_at' : 'plan.unreachable', {
        time, target: plan.target, expected: plan.expected,
      });
    }
    await this._set('stove_start_time', text);
  }

  _sensorTrigger(card, e) {
    const tokens = {
      role: this.homey.__(`sensor_role.${e.role}`),
      sensor: e.sensor || '',
    };
    if (card === 'sensor_unavailable') {
      tokens.reason = this.homey.__(`sensor_reason.${e.reason}`);
      tokens.replacement = e.replacement || '—';
    }
    this.homey.flow.getDeviceTriggerCard(card).trigger(this, tokens).catch(this.error);
  }

  async _set(capability, value, allowNull = false) {
    if (value === undefined || Number.isNaN(value)) return;
    if (value === null && !allowNull) return;
    if (!this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    await this.setCapabilityValue(capability, value).catch(this.error);
  }

  async onSettings({ changedKeys }) {
    if (changedKeys.some((k) => ['mode', 'host', 'port'].includes(k))) {
      this.homey.setTimeout(() => {
        this._connect();
        this._schedule(1000);
      }, 500);
    } else if (changedKeys.includes('poll_interval')) {
      this._schedule(1000);
    }
  }

  async onUninit() {
    this._stop();
  }

  async onDeleted() {
    this._stop();
  }

  _stop() {
    this.stopped = true;
    const { sensors } = this.homey.app;
    if (sensors && this._onSensors) {
      sensors.off('update', this._onSensors);
      sensors.off('sensor_unavailable', this._onSensorDown);
      sensors.off('sensor_restored', this._onSensorUp);
    }
    if (this._onPlan) this.homey.app.off('plan', this._onPlan);
    if (this._onStartDue) this.homey.app.off('heat_start_due', this._onStartDue);
    if (this._onHeatLoss) this.homey.app.off('heat_loss', this._onHeatLoss);
    if (this._onConsumables) this.homey.app.off('consumables', this._onConsumables);
    if (this._onConsumableEvent) this.homey.app.off('consumable_event', this._onConsumableEvent);
    this.homey.clearTimeout(this.pollTimer);
    if (this.connection) this.connection.close();
  }

}

module.exports = StoveDevice;
