'use strict';

const Homey = require('homey');
const { createConnection } = require('../../lib/connection');
const { DuepiClient } = require('../../lib/duepi/client');

const UNAVAILABLE_AFTER = 3; // consecutive failed snapshots

class StoveDevice extends Homey.Device {

  async onInit() {
    this.failures = 0;
    this.lastStatus = null;
    this.lastErrorCode = null;
    this.pollTimer = null;
    this.stopped = false;

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
      if (this.failures >= UNAVAILABLE_AFTER) this.log('Connection restored');
      this.failures = 0;
      if (!this.getAvailable()) await this.setAvailable();
    } catch (err) {
      this.failures += 1;
      this.log(`Snapshot failed (${this.failures}): ${err.message}`);
      if (this.failures === UNAVAILABLE_AFTER) {
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

  async _set(capability, value) {
    if (value === undefined || value === null || Number.isNaN(value)) return;
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
    this.homey.clearTimeout(this.pollTimer);
    if (this.connection) this.connection.close();
  }

}

module.exports = StoveDevice;
