'use strict';

const Homey = require('homey');
const { HomeyDevices } = require('./lib/homey-devices');
const { SensorHub } = require('./lib/sensors');
const { MeteoFranceForecast } = require('./lib/forecast');

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
    this.sensors.on('sensor_unavailable', (e) => this.log(`Sensor ${e.role} unavailable (${e.reason})`));

    this.homey.settings.on('set', (key) => {
      if (key === 'sensors') this.refreshSensors();
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
    return { ...rest, roles };
  }

  async onUninit() {
    if (this.sensorTimer) this.homey.clearInterval(this.sensorTimer);
  }

}

module.exports = PelletStoveApp;
