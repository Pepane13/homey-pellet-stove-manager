'use strict';

const { DuepiTransport } = require('./duepi/transport');
const { SimulatedStove } = require('./duepi/simulator');

/**
 * Build the transport matching a device configuration.
 * @param {{mode: string, host?: string, port?: number, code?: string}} config
 */
function createConnection(config, log) {
  if (config.mode === 'simulator') return new SimulatedStove({ speed: 6 });
  return new DuepiTransport({
    mode: config.mode === 'local' ? 'local' : 'cloud',
    host: config.host || undefined,
    port: config.port || undefined,
    code: config.code,
    log,
  });
}

module.exports = { createConnection };
