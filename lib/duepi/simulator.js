'use strict';

/**
 * In-process simulated stove, used for development and demos without hardware.
 * Implements the same `request(command)` interface as DuepiTransport and follows a
 * simple cycle: off -> ignition -> heating -> cooling -> off.
 */

const { EventEmitter } = require('events');

const PHASES = [
  { status: 0x00000020, minutes: 20 }, // off
  { status: 0x01010022, minutes: 12 }, // ignition
  { status: 0x02010023, minutes: 90 }, // heating
  { status: 0x08010029, minutes: 15 }, // cooling
];

const hex = (n, digits) => n.toString(16).toUpperCase().padStart(digits, '0');

class SimulatedStove extends EventEmitter {

  constructor({ speed = 1, hoursTotal = 1735, hoursService = 12, error = 0 } = {}) {
    super();
    this.speed = speed;
    this.start = Date.now();
    this.hoursTotal = hoursTotal;
    this.hoursService = hoursService;
    this.error = error;
    this.power = 3;
    this.setpoint = 20;
    this.connected = true;
  }

  _phase() {
    const cycle = PHASES.reduce((s, p) => s + p.minutes, 0);
    let t = (((Date.now() - this.start) / 60000) * this.speed) % cycle;
    for (const p of PHASES) {
      if (t < p.minutes) return p.status;
      t -= p.minutes;
    }
    return PHASES[0].status;
  }

  async request(command) {
    const status = this.error ? 0x00000020 : this._phase();
    const heating = status === 0x02010023;
    const ignition = status === 0x01010022;
    const cooling = status === 0x08010029;
    const pad = (v) => `${hex(v, 4)}0020`;
    switch (command) {
      case 'D9000': return hex(status, 8);
      case 'DA000': return pad(this.error);
      case 'D3000': return pad(heating || ignition ? this.power : 1);
      case 'D0000': return pad(heating ? 95 + this.power * 15 : cooling ? 70 : ignition ? 45 : 20);
      case 'DF000': return pad(heating ? 38 : 33);
      case 'D4000': return pad(heating ? 10 + this.power * 4 : 0);
      case 'EF000': return pad(heating || ignition || cooling ? 140 : 0);
      case 'D1000': return '03E7003F'; // no ambient probe
      case 'C6000': return pad(this.setpoint);
      case 'C0000': return '01000021';
      case 'ED000': return `${hex(this.hoursTotal, 6)}40`;
      case 'EE000': return `${hex(this.hoursService, 6)}33`;
      default: return '00000020';
    }
  }

  close() {}

}

module.exports = { SimulatedStove };
