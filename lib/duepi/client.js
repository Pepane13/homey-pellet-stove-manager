'use strict';

const { READ, DECODERS } = require('./protocol');

/** Order matters: status first; if it fails the snapshot is rejected. */
const SNAPSHOT = [
  'status', 'error', 'powerLevel', 'flueGas', 'board', 'auger', 'exhaust',
  'ambient', 'setpoint', 'pressureSwitch', 'hoursTotal', 'hoursService',
];

class DuepiClient {

  /** @param {{request: function(string): Promise<string>}} transport */
  constructor(transport) {
    this.transport = transport;
  }

  async read(name) {
    const payload = await this.transport.request(READ[name]);
    return DECODERS[name](payload);
  }

  /**
   * Read a full state snapshot. Optional values that fail are reported in `missing`
   * instead of failing the whole snapshot.
   */
  async snapshot(names = SNAPSHOT) {
    const state = { at: Date.now(), missing: [] };
    for (const name of names) {
      try {
        state[name] = await this.read(name);
      } catch (err) {
        if (name === 'status') throw err;
        state.missing.push(name);
      }
    }
    return state;
  }

}

module.exports = { DuepiClient, SNAPSHOT };
