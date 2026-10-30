'use strict';

/**
 * Access to the other Homey devices (temperature sensors, thermostat) through the Homey Web API.
 * Requires the "homey:manager:api" permission. Writes are limited to the thermostat chosen
 * in the regulation settings (setpoint, back to schedule).
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

  async setCapability(deviceId, capabilityId, value) {
    const api = await this.api();
    return api.devices.setCapabilityValue({ deviceId, capabilityId, value });
  }

  /** Runs a device Flow action card, e.g. Netatmo « thermostat_set_mode » {mode: 'schedule'}. */
  async runDeviceAction(deviceId, cardId, args = {}) {
    const api = await this.api();
    const uri = `homey:device:${deviceId}`;
    try {
      return await api.flow.runFlowCardAction({ uri, id: `${uri}:${cardId}`, args });
    } catch (err) {
      return api.flow.runFlowCardAction({ uri, id: cardId, args });
    }
  }

  /** Choices of a device action card argument (e.g. Netatmo schedules), via the card autocomplete. */
  async deviceActionChoices(deviceId, cardId, argName) {
    const api = await this.api();
    const uri = `homey:device:${deviceId}`;
    const ask = (id) => api.flow.getFlowCardAutocomplete({
      type: 'flowcardaction', uri, id, name: argName, query: '',
    });
    let list;
    try {
      list = await ask(`${uri}:${cardId}`);
    } catch (err) {
      list = await ask(cardId);
    }
    return (Array.isArray(list) ? list : []).filter((x) => x && x.id != null);
  }

  /** Thermostats (target_temperature) for the regulation settings. */
  async listThermostats() {
    const api = await this.api();
    const devices = await api.devices.getDevices();
    return Object.values(devices)
      .filter((d) => d.capabilitiesObj && d.capabilitiesObj.target_temperature)
      .map((d) => ({
        id: d.id,
        name: d.name,
        target: d.capabilitiesObj.target_temperature.value,
        hasModes: !!(d.capabilitiesObj.thermostat_mode || (d.capabilities || []).some((c) => c.startsWith('thermostat_mode'))),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
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
