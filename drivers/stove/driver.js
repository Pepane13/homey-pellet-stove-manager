'use strict';

const crypto = require('crypto');
const Homey = require('homey');
const { createConnection } = require('../../lib/connection');
const { DuepiClient } = require('../../lib/duepi/client');

class StoveDriver extends Homey.Driver {

  async onInit() {
    this.homey.flow.getConditionCard('stove_is_heating')
      .registerRunListener(async ({ device }) => device.getCapabilityValue('stove_status') === 'heating');
    this.homey.flow.getConditionCard('stove_has_alarm')
      .registerRunListener(async ({ device }) => device.getCapabilityValue('alarm_generic') === true);
    this.log('Pellet stove driver initialised');
  }

  async onPair(session) {
    // Single-screen pairing: the view tests the connection, then creates the device itself.
    session.setHandler('configure', async (data) => {
      const config = {
        mode: ['cloud', 'local', 'simulator'].includes(data.mode) ? data.mode : 'cloud',
        code: String(data.code || '').trim().replace(/#+$/, ''),
        host: String(data.host || '').trim(),
        port: Number(data.port) || undefined,
      };
      if (config.mode === 'cloud' && !config.code) throw new Error(this.homey.__('pair.error_code'));
      if (config.mode === 'local' && !config.host) throw new Error(this.homey.__('pair.error_host'));

      const connection = createConnection(config, this.log.bind(this));
      let status;
      let hours = null;
      try {
        const client = new DuepiClient(connection);
        status = await client.read('status');
        hours = await client.read('hoursTotal').catch(() => null);
      } catch (err) {
        this.log('Pairing test failed:', err.message);
        throw new Error(this.homey.__('pair.error_connect', { error: err.message }));
      } finally {
        connection.close();
      }

      // The device id is a hash: the device code is a credential and is only kept in the store.
      const id = crypto.createHash('sha256')
        .update(`${config.mode}|${config.code || config.host || 'simulator'}`)
        .digest('hex')
        .slice(0, 16);
      const isSimulator = config.mode === 'simulator';
      return {
        message: this.homey.__('pair.success', {
          status: this.homey.__(`status.${status.status}`),
          hours: hours == null ? '?' : hours,
        }),
        device: {
          name: this.homey.__(isSimulator ? 'pair.device_name_simulator' : 'pair.device_name'),
          data: { id },
          store: { code: config.code || null },
          settings: {
            mode: config.mode,
            host: isSimulator ? '' : config.host,
            port: config.port || (config.mode === 'local' ? 23 : 3000),
          },
        },
      };
    });
  }

}

module.exports = StoveDriver;
