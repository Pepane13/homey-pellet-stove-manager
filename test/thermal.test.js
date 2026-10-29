'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ThermalLearner, localTime, nextOccurrence, PRIORS } = require('../lib/thermal');

const MIN = 60e3;
const HOUR = 3600e3;
const TZ = 'Europe/Paris';

function learner(now = () => Date.parse('2026-10-29T06:00:00Z')) {
  const mem = {};
  return { l: new ThermalLearner({ store: { get: (k) => mem[k], set: (k, v) => { mem[k] = v; } }, timeZone: () => TZ, now }), mem };
}

// Simulate the house with known parameters, one sample per minute
function run(l, { from, hours, stove, k, G = 0, lag = 0, start, out = 10, noise = 0, drop = null, power }) {
  let T = start;
  let R = start - 0.3;
  const samples = [];
  for (let i = 0; i <= hours * 60; i++) {
    const t = from + i * MIN;
    const on = stove !== 'off' && i >= lag;
    l.observe({ t, comfort: Math.round((T + (noise ? Math.sin(i) * noise : 0)) * 10) / 10, regulation: Math.round(R * 10) / 10, outdoor: out, stove, power });
    samples.push(T);
    T += ((on ? G : 0) - k * (T - out)) / 60;
    R += ((on ? G * 0.4 : 0) - k * 0.6 * (R - out)) / 60;
    if (drop && i === drop) T -= 0.6;
  }
  return T;
}

test('local time follows the Paris time zone, DST included', () => {
  assert.strictEqual(localTime(Date.parse('2026-10-28T20:30:00Z'), TZ), 21.5); // winter, UTC+1
  assert.strictEqual(localTime(Date.parse('2026-07-01T20:30:00Z'), TZ), 22.5); // summer, UTC+2
  const now = Date.parse('2026-10-28T20:30:15Z');
  assert.strictEqual(new Date(nextOccurrence('06:20', now, TZ)).toISOString(), '2026-10-29T05:20:00.000Z');
  assert.strictEqual(nextOccurrence('bad', now, TZ), null);
});

test('learns the losses from a quiet night with the stove off', () => {
  const { l } = learner();
  // stove stops at 22:00 local (21:00Z), off until 06:00 local
  run(l, { from: Date.parse('2026-10-28T20:30:00Z'), hours: 0.5, stove: 'cooling', k: 0.02, start: 21 });
  run(l, { from: Date.parse('2026-10-28T21:00:00Z'), hours: 8, stove: 'off', k: 0.02, start: 21, out: 8 });
  l.observe({ t: Date.parse('2026-10-29T05:01:00Z'), comfort: 19, regulation: 19, outdoor: 8, stove: 'ignition' });
  const ev = l.summary().history.find((e) => e.type === 'cooling' && e.sensor === 'comfort');
  assert.ok(ev.accepted, JSON.stringify(ev));
  assert.ok(Math.abs(ev.value - 0.02) < 0.003, `k=${ev.value}`);
  const k = l.param('comfort', 'k');
  assert.ok(k > PRIORS.comfort.k && k < 0.02, `blended k=${k}`);
});

test('ignores a night with a window opened', () => {
  const { l } = learner();
  run(l, { from: Date.parse('2026-10-28T21:00:00Z'), hours: 8, stove: 'off', k: 0.012, start: 21, out: 8, drop: 200 });
  l.observe({ t: Date.parse('2026-10-29T05:01:00Z'), comfort: 19, regulation: 19, outdoor: 8, stove: 'ignition' });
  const ev = l.summary().history.find((e) => e.sensor === 'comfort');
  assert.strictEqual(ev.accepted, false);
  assert.strictEqual(ev.reason, 'window');
  assert.strictEqual(l.param('comfort', 'k'), PRIORS.comfort.k);
});

test('learns the heating gain and lag from a morning heat-up', () => {
  const { l } = learner();
  run(l, { from: Date.parse('2026-10-29T04:00:00Z'), hours: 2.5, stove: 'heating', k: 0.012, G: 0.9, lag: 25, start: 18, out: 6 });
  l.observe({ t: Date.parse('2026-10-29T06:31:00Z'), comfort: 20, regulation: 20, outdoor: 6, stove: 'cooling' });
  const ev = l.summary().history.find((e) => e.type === 'heating' && e.sensor === 'comfort');
  assert.ok(ev.accepted, JSON.stringify(ev));
  assert.ok(Math.abs(ev.value - 0.9) < 0.12, `gain=${ev.value}`);
  assert.ok(ev.lag >= 25 && ev.lag <= 45, `lag=${ev.lag}`);
});

test('rejects a heat-up started in the afternoon sun', () => {
  const { l } = learner();
  run(l, { from: Date.parse('2026-10-29T12:00:00Z'), hours: 2, stove: 'heating', k: 0.012, G: 0.9, start: 18, out: 14 });
  l.observe({ t: Date.parse('2026-10-29T14:01:00Z'), comfort: 20, regulation: 20, outdoor: 14, stove: 'off' });
  const ev = l.summary().history.find((e) => e.sensor === 'comfort');
  assert.strictEqual(ev.reason, 'sun');
});

test('plans the latest start reaching the target, consistent with a simulation', () => {
  const now = Date.parse('2026-10-28T21:30:00Z'); // 22:30 local
  const { l } = learner(() => now);
  const at = nextOccurrence('06:20', now, TZ);
  const p = l.plan({ sensor: 'comfort', target: 21, at, current: 20.5, outdoorAt: () => 6 });
  assert.ok(p.needed && p.reachable);
  // with priors: k 0.012, G 0.62, lag 30 -> T drops to ~19.1 °C, then ~+0.47 °C/h
  assert.ok(p.minutes > 180 && p.minutes < 360, `minutes=${p.minutes}`);
  assert.ok(p.expected >= 21);
  const colder = l.plan({ sensor: 'comfort', target: 21, at, current: 20.5, outdoorAt: () => 0 });
  assert.ok(colder.minutes > p.minutes, 'colder night needs an earlier start');
  const none = l.plan({ sensor: 'comfort', target: 19, at, current: 21, outdoorAt: () => 12 });
  assert.strictEqual(none.needed, false);
  const impossible = l.plan({ sensor: 'regulation', target: 26, at, current: 18, outdoorAt: () => 0 });
  assert.strictEqual(impossible.reachable, false);
});

test('persists the learning and can be reset', () => {
  const { l, mem } = learner();
  run(l, { from: Date.parse('2026-10-28T21:00:00Z'), hours: 8, stove: 'off', k: 0.02, start: 21, out: 8 });
  l.observe({ t: Date.parse('2026-10-29T05:01:00Z'), comfort: 19, regulation: 19, outdoor: 8, stove: 'ignition' });
  const again = new ThermalLearner({ store: { get: (k) => mem[k], set: (k, v) => { mem[k] = v; } }, timeZone: () => TZ });
  assert.strictEqual(again.param('comfort', 'k'), l.param('comfort', 'k'));
  again.reset();
  assert.strictEqual(again.param('comfort', 'k'), PRIORS.comfort.k);
});

test('keeps one loss point per night for the insulation curve and compares before/after works', () => {
  const { l } = learner();
  const nights = [];
  l.onNight = (n) => nights.push(n);
  const night = (day, k) => {
    run(l, { from: Date.parse(`2026-11-${day}T21:00:00Z`), hours: 8, stove: 'off', k, start: 21, out: 8 });
    l.observe({ t: Date.parse(`2026-11-${day}T05:01:00Z`) + 86400e3, comfort: 19, regulation: 19, outdoor: 8, stove: 'ignition' });
    l.observe({ t: Date.parse(`2026-11-${day}T05:02:00Z`) + 86400e3, comfort: 19, regulation: 19, outdoor: 8, stove: 'cooling' });
  };
  night('01', 0.02);
  night('03', 0.02);
  night('10', 0.012);
  night('12', 0.012);
  assert.strictEqual(nights.length, 4);
  assert.ok(Math.abs(nights[0].comfort - 0.2) < 0.02, `night loss ${nights[0].comfort}`);
  const s = l.lossSummary('2026-11-05');
  assert.strictEqual(s.works.before.nights, 2);
  assert.strictEqual(s.works.after.nights, 2);
  assert.ok(s.works.gainComfort >= 35 && s.works.gainComfort <= 45, `gain ${s.works.gainComfort} %`);
  l.reset();
  assert.strictEqual(l.lossSummary().nights.length, 4, 'reset keeps the curve');
});

test('rebuilds the loss curve from the 0.3.1 journal', () => {
  const mem = { thermal_learning: { history: [
    { at: Date.parse('2026-10-29T05:00:00Z'), type: 'cooling', sensor: 'comfort', value: 0.0137, accepted: true, outdoor: 11.7, hours: 7.3 },
    { at: Date.parse('2026-10-29T05:00:00Z'), type: 'cooling', sensor: 'regulation', value: 0.0086, accepted: true, outdoor: 11.7, hours: 7.3 },
  ] } };
  const l = new ThermalLearner({ store: { get: (k) => mem[k], set: (k, v) => { mem[k] = v; } }, timeZone: () => TZ });
  const n = l.lossSummary().nights;
  assert.strictEqual(n.length, 1);
  assert.strictEqual(n[0].date, '2026-10-28');
  assert.strictEqual(n[0].comfort, 0.137);
  assert.strictEqual(n[0].regulation, 0.086);
});

test('learns the heating gain per power level and uses it once confirmed', () => {
  const { l } = learner();
  for (let d = 0; d < 3; d++) {
    const day = Date.parse('2026-10-29T04:00:00Z') + d * 86400e3;
    run(l, { from: day, hours: 2.5, stove: 'heating', k: 0.012, G: 1.2, lag: 25, start: 18, out: 6, power: 5 });
    l.observe({ t: day + 151 * MIN, comfort: 20, regulation: 20, outdoor: 6, stove: 'cooling', power: 5 });
  }
  const bp = l.summary().byPower.comfort;
  assert.strictEqual(bp[5].samples, 3);
  assert.ok(Math.abs(bp[5].value - 1.2) < 0.15, `gain P5=${bp[5].value}`);
  assert.strictEqual(l.gainFor('comfort', 5), l.data.byPower.comfort[5].value);
  assert.strictEqual(l.gainFor('comfort', 2), l.param('comfort', 'gain'), 'unknown level: overall gain');
  l.reset();
  assert.deepStrictEqual(l.summary().byPower.comfort || {}, {});
});
