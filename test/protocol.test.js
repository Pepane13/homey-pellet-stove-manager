'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { DECODERS, WRITE, isAck } = require('../lib/duepi/protocol');

test('status phases from documented and captured replies', () => {
  const s = (p) => DECODERS.status(p).status;
  assert.strictEqual(s('00000020'), 'off');
  assert.strictEqual(s('01010022'), 'ignition');
  assert.strictEqual(s('02010023'), 'heating');
  assert.strictEqual(s('0802002A'), 'cooling');
  assert.strictEqual(s('08010029'), 'cooling');
});

test('values read from the owner\'s stove on 28/10/2026', () => {
  assert.strictEqual(DECODERS.powerLevel('00010021'), 1);
  assert.strictEqual(DECODERS.ambient('03E7003F'), null); // no probe: 99.9 °C
  assert.strictEqual(DECODERS.flueGas('00140025'), 20);
  assert.strictEqual(DECODERS.board('00210023'), 33);
  assert.strictEqual(DECODERS.hoursTotal('0006C740'), 1735);
  assert.strictEqual(DECODERS.hoursService('00000C33'), 12);
  assert.strictEqual(DECODERS.pressureSwitch('01000021'), 'normal');
  assert.strictEqual(DECODERS.setpoint('00000020'), null);
  assert.strictEqual(DECODERS.error('00000020').code, 0);
});

test('error decoding', () => {
  const e = DECODERS.error('00050025');
  assert.strictEqual(e.id, 'out_of_pellets');
  assert.strictEqual(e.fr, 'Manque de pellets');
  assert.strictEqual(DECODERS.error('00070027').id, 'unknown_7');
});

test('ambient temperature with a probe', () => {
  assert.strictEqual(DECODERS.ambient('00E9003E'), 23.3);
});

test('write commands', () => {
  assert.strictEqual(WRITE.power(0), 'F0000');
  assert.strictEqual(WRITE.power(3), 'F0030');
  assert.throws(() => WRITE.power(6));
  assert.strictEqual(WRITE.setpoint(20), 'F2140');
  assert.strictEqual(WRITE.resetAlarm(), 'D6000');
  assert.ok(isAck('00000020'));
});
