'use strict';

/**
 * Read-only access to the other Homey devices (temperature sensors, thermostat),
 * through the Homey Web API. Requires the "homey:manager:api" permission.
 */

const { HomeyAPI } = require('homey-api');

class HomeyDevices {

  constructor(homey) {
    this.homey = homey;
    this.apiPromise = null;
  }

  api() {
    if (!this.apiPromise) {
      this.apiPromise = HomeyAPI.createAppAPI({ homey: this.homey }).catch((err) => {
        this.apiPromise = null;
        throw err;
      });
    }
    return this.apiPromise;
  }

  async readDevice(id) {
    const api = await this.api();
    return api.devices.getDevice({ id });
  }

  /** Every device capability that reports a temperature, for the settings page. */
  async listTemperatureSources() {
    const api = await this.api();
    const [devices, zones] = await Promise.all([api.devices.getDevices(), api.zones.getZones()]);
    const zoneName = (id) => (zones[id] ? zones[id].name : '');
    const sources = [];
    for (const device of Object.values(devices)) {
      const caps = device.capabilitiesObj || {};
      for (const [capability, obj] of Object.entries(caps)) {
        if (!capability.startsWith('measure_temperature')) continue;
        sources.push({
          deviceId: device.id,
          deviceName: device.name,
          deviceClass: device.class,
          zone: zoneName(device.zone),
          capability,
          title: obj.title || capability,
          value: typeof obj.value === 'number' ? obj.value : null,
          lastUpdated: obj.lastUpdated || null,
          hasOnOff: !!caps.onoff,
          isForecast: !!caps['measure_temperature.min_next_6_hours'],
        });
      }
    }
    sources.sort((a, b) => (a.zone + a.deviceName).localeCompare(b.zone + b.deviceName, 'fr'));
    return sources;
  }

}

module.exports = { HomeyDevices };
