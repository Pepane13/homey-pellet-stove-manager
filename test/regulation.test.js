'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Regulator } = require('../lib/regulation');

function make(cfg) {
  const mem = { regulation: { thermostatId: 'th', ...cfg } };
  const clock = { t: Date.parse('2026-11-02T06:00:00Z') };
  const r = new Regulator({ store: { get: (k) => mem[k], set: (k, v) => { mem[k] = v; } }, now: () => clock.t });
  return { r, clock, mem };
}
const base = { stoveReachable: true, commandsEnabled: true, stoveHeating: true, power: 3 };

test('flows mode never acts', () => {
  const { r } = make({ mode: 'flows' });
  r.setHold(21);
  assert.deepStrictEqual(r.step({ ...base, comfort: 19, regulation: 18.5 }), []);
});

test('netatmo mode compensates the comfort/thermostat gap, bounded and rounded', () => {
  const { r, clock } = make({ mode: 'netatmo' });
  r.setHold(21);
  let a = r.step({ ...base, comfort: 21.5, regulation: 21.0 }); // séjour warmer by 0.5
  assert.deepStrictEqual(a.map((x) => [x.type, x.value]), [['setpoint', 20.5]]);
  clock.t += 60e3;
  assert.strictEqual(r.step({ ...base, comfort: 21.5, regulation: 21.0 }).length, 0, 'unchanged');
  // a cold hall (gap +3) is limited to 1.5
  for (let i = 0; i < 60; i++) { clock.t += 60e3; r.step({ ...base, comfort: 22, regulation: 19 }); }
  assert.strictEqual(r.compensatedSetpoint(21), 19.5);
  // the thermostat went back to its schedule by itself: written again
  clock.t += 11 * 60e3;
  const again = r.step({ ...base, comfort: 22, regulation: 19, thermostatTarget: 19 });
  assert.deepStrictEqual(again.map((x) => x.value), [19.5]);
  r.clearHold();
  assert.strictEqual(r.step({ ...base, comfort: 22, regulation: 19 }).length, 0);
});

test('direct mode: hysteresis on the comfort sensor and fallback to the schedule', () => {
  const { r, clock } = make({ mode: 'direct' });
  r.setHold(21);
  let a = r.step({ ...base, comfort: 20.5, regulation: 20 });
  assert.deepStrictEqual(a.map((x) => x.type), ['setpoint', 'stove']);
  assert.strictEqual(a[1].on, true);
  clock.t += 60e3;
  assert.strictEqual(r.step({ ...base, comfort: 21.1, regulation: 20.6 }).filter((x) => x.type === 'stove').length, 0, 'inside the band');
  a = r.step({ ...base, comfort: 21.3, regulation: 20.8 });
  assert.strictEqual(a.find((x) => x.type === 'stove').on, false);
  a = r.step({ ...base, stoveReachable: false, comfort: 21.3, regulation: 20.8 });
  assert.deepStrictEqual(a.map((x) => x.type), ['schedule']);
  assert.strictEqual(r.step({ ...base, stoveReachable: false, comfort: 21.3 }).length, 0, 'fallback once');
  a = r.step({ ...base, comfort: 20.5, regulation: 20 });
  assert.deepStrictEqual(a.map((x) => x.type), ['setpoint', 'stove']);
});

test('automatic power follows the distance to the target', () => {
  const { r, clock } = make({ mode: 'netatmo', autoPower: true, maxPower: 4 });
  r.setHold(21);
  let a = r.step({ ...base, comfort: 18.5, regulation: 18, power: 2 });
  assert.strictEqual(a.find((x) => x.type === 'power').level, 4); // 1 + 5 = 6 -> max 4
  clock.t += 11 * 60e3;
  a = r.step({ ...base, comfort: 20.8, regulation: 20.5, power: 4 });
  assert.strictEqual(a.find((x) => x.type === 'power').level, 1);
  clock.t += 60e3;
  assert.ok(!r.step({ ...base, comfort: 19, regulation: 18.5, power: 1 }).some((x) => x.type === 'power'), 'at most every 10 min');
  assert.ok(!r.step({ ...base, commandsEnabled: false, comfort: 19, power: 1 }).some((x) => x.type === 'power'));
});
