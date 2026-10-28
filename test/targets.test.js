'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { TargetPlanner } = require('../lib/targets');

function planner(clock) {
  const mem = {};
  return new TargetPlanner({ store: { get: (k) => mem[k], set: (k, v) => { mem[k] = v; } }, now: () => clock.t, timeZone: () => 'Europe/Paris' });
}

const AT = Date.parse('2026-10-29T05:20:00Z'); // 06:20 Paris

test('raises the start at the computed time, once', () => {
  const clock = { t: Date.parse('2026-10-28T23:00:00Z') };
  const p = planner(clock);
  const target = p.add(21, '06:20');
  assert.strictEqual(target.at, AT);
  const plan = () => ({ needed: true, reachable: true, startAt: AT - 150 * 60e3 });
  let r = p.evaluate(plan);
  assert.strictEqual(r.due.length, 0);
  assert.strictEqual(r.next.target.temperature, 21);
  clock.t = AT - 150 * 60e3;
  r = p.evaluate(plan);
  assert.strictEqual(r.due.length, 1);
  assert.strictEqual(r.due[0].lead, 150);
  assert.strictEqual(p.evaluate(plan).due.length, 0);
});

test('a warm house still raises the event shortly before the target time', () => {
  const clock = { t: AT - 60 * 60e3 };
  const p = planner(clock);
  p.add(19, '06:20');
  const plan = () => ({ needed: false, reachable: true });
  assert.strictEqual(p.evaluate(plan).due.length, 0);
  clock.t = AT - 4 * 60e3;
  const r = p.evaluate(plan);
  assert.strictEqual(r.due.length, 1);
  assert.strictEqual(r.due[0].needed, false);
});

test('without a plan (sensor missing) the event is raised at the target time', () => {
  const clock = { t: AT - 60 * 60e3 };
  const p = planner(clock);
  p.add(21, '06:20');
  assert.strictEqual(p.evaluate(() => null).due.length, 0);
  clock.t = AT + 60e3;
  const r = p.evaluate(() => null);
  assert.strictEqual(r.due.length, 1);
  assert.strictEqual(r.due[0].needed, true);
});

test('replaces a target for the same time, rejects bad input, cancels', () => {
  const clock = { t: AT - 3600e3 };
  const p = planner(clock);
  p.add(21, '06:20');
  p.add(20, '06:20');
  p.add(21, '18:30');
  assert.deepStrictEqual(p.list().map((x) => x.temperature), [20, 21]);
  assert.throws(() => p.add(21, '6h20'));
  assert.throws(() => p.add(45, '06:20'));
  p.cancel();
  assert.strictEqual(p.list().length, 0);
});
