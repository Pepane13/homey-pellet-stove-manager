'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Consumables, ratePerHour, kgPerDay, addMonths } = require('../lib/consumables');

const MIN = 60e3;
const HOUR = 3600e3;

function make(start = Date.parse('2026-11-02T10:00:00Z')) {
  const mem = {};
  const clock = { t: start };
  const c = new Consumables({ store: { get: (k) => mem[k], set: (k, v) => { mem[k] = v; } }, now: () => clock.t, timeZone: () => 'Europe/Paris' });
  return { c, clock, mem };
}

// Burn for a number of hours at a power level, one snapshot per minute
function burn(c, clock, hours, { power = 3, status = 'heating', errorCode = 0, hoursService = 100 } = {}) {
  for (let i = 0; i < hours * 60; i++) {
    clock.t += MIN;
    c.observe({ t: clock.t, status, power, errorCode, hoursService, hoursTotal: 1800 });
  }
}

test('nominal rates and daily need follow the stove data and the history model', () => {
  assert.strictEqual(ratePerHour(1), 0.95);
  assert.strictEqual(ratePerHour(5), 2.33);
  assert.ok(Math.abs(kgPerDay(5) - 13.2) < 0.3, `5 °C: ${kgPerDay(5)}`);
  assert.ok(Math.abs(kgPerDay(11.8) * 30 - 166) < 3);
  assert.ok(kgPerDay(19) > 0 && kgPerDay(25) === 0);
  assert.strictEqual(addMonths('2026-08-27', 12), '2027-08-27');
  assert.strictEqual(addMonths('2026-01-31', 1), '2026-02-28');
});

test('integrates consumption while burning and raises the low-tank event once', () => {
  const { c, clock } = make();
  c.refilled();
  burn(c, clock, 4, { power: 3 }); // 1.64 kg/h
  assert.ok(Math.abs(c.pelletState().kgLeft - (19 - 6.56)) < 0.1);
  burn(c, clock, 2, { status: 'off' });
  assert.ok(Math.abs(c.pelletState().kgLeft - 12.4) < 0.1, 'no consumption when off');
  burn(c, clock, 6);
  const ev = c.takeEvents().filter((e) => e.type === 'pellets_low');
  assert.strictEqual(ev.length, 1);
  c.refilled();
  assert.strictEqual(c.pelletState().kgLeft, 19);
});

test('learns the real consumption only when the tank runs empty', () => {
  const { c, clock } = make();
  c.refilled();
  burn(c, clock, 9, { power: 2 }); // model 1.295 kg/h -> 11.7 kg
  c.observe({ t: clock.t + MIN, status: 'off', power: 2, errorCode: 5, hoursService: 100, hoursTotal: 1800 });
  const st = c.pelletState();
  assert.strictEqual(st.kgLeft, 0);
  assert.ok(st.factor > 1.1 && st.factor < 1.6, `factor ${st.factor}`); // 19 / 11.7 = 1.63, blended with the prior
  assert.strictEqual(st.factorSamples, 1);
  // an evening top-up does not touch the factor
  c.refilled();
  burn(c, clock, 3);
  c.refilled();
  assert.strictEqual(c.pelletState().factorSamples, 1);
});

test('evening advice compares the tank with the night need', () => {
  const { c, clock } = make(Date.parse('2026-11-02T19:59:00Z')); // 20:59 Paris
  c.refilled();
  c.data.pellets.kgBurned = 17; // 2 kg left
  clock.t += 2 * MIN; // 21:01
  c.tick(5);
  const e = c.takeEvents();
  assert.strictEqual(e[e.length - 1].type, 'pellets_refill_advised');
  c.tick(5);
  assert.strictEqual(c.takeEvents().filter((x) => x.type.startsWith('pellets_refill')).length, 0, 'once a day');
  const { c: c2, clock: k2 } = make(Date.parse('2026-11-02T19:59:00Z'));
  c2.refilled();
  k2.t += 2 * MIN;
  c2.tick(12);
  assert.ok(c2.takeEvents().some((x) => x.type === 'pellets_refill_not_needed'));
});

test('monthly forecast on the first day of the month', () => {
  const { c, clock } = make(Date.parse('2026-12-01T08:30:00Z')); // 09:30 Paris
  c.tick(9);
  const e = c.takeEvents().find((x) => x.type === 'monthly_forecast');
  assert.ok(e, 'forecast raised');
  assert.strictEqual(e.tokens.bags, Math.ceil(e.tokens.kg / 15));
  assert.ok(e.tokens.kg > 230 && e.tokens.kg < 300, `december ${e.tokens.kg} kg`);
  assert.strictEqual(e.tokens.cost, Math.round(e.tokens.bags * 5.49 * 100) / 100);
  clock.t += 3600e3;
  c.tick(9);
  assert.ok(!c.takeEvents().some((x) => x.type === 'monthly_forecast'));
  c.setBagPrice(6);
  assert.strictEqual(c.monthForecast(2027, 1).price, 6);
  assert.throws(() => c.setBagPrice(-1));
});

test('cleaning counter, pre-alert and reset', () => {
  const { c, clock } = make();
  burn(c, clock, 18);
  assert.ok(c.takeEvents().some((e) => e.type === 'cleaning_soon'));
  burn(c, clock, 5);
  const e = c.takeEvents();
  assert.ok(e.some((x) => x.type === 'cleaning_due'));
  assert.ok(c.cleaningState().due);
  c.cleaned();
  assert.strictEqual(c.cleaningState().hours, 0);
});

test('maintenance: 12 months or 1200 h, whichever first, with journal', () => {
  const { c, clock } = make(Date.parse('2027-07-30T10:00:00Z'));
  c.observe({ t: clock.t, status: 'off', power: 1, errorCode: 0, hoursService: 700, hoursTotal: 2423 });
  let s = c.maintenanceState();
  assert.strictEqual(s.dueDate, '2027-08-27');
  assert.ok(s.soon && !s.due);
  assert.ok(c.takeEvents().some((e) => e.type === 'maintenance_soon'));
  c.observe({ t: clock.t + MIN, status: 'off', power: 1, errorCode: 0, hoursService: 1200, hoursTotal: 2923 });
  s = c.maintenanceState();
  assert.ok(s.due);
  assert.ok(c.takeEvents().some((e) => e.type === 'maintenance_due'));
  c.serviced({ note: 'Entretien annuel', cost: 210 });
  s = c.maintenanceState();
  assert.strictEqual(s.lastDate, '2027-07-30');
  assert.strictEqual(s.journal[0].note, 'Entretien annuel');
  assert.strictEqual(s.journal.length, 4);
});

test('a refill with the level seen learns the factor; the level at installation is unknown', () => {
  const mem = {};
  const clock = { t: Date.parse('2026-11-02T06:00:00Z') };
  const { Consumables } = require('../lib/consumables');
  const c = new Consumables({ store: { get: (k) => mem[k], set: (k, v) => { mem[k] = v; } }, now: () => clock.t, timeZone: () => 'Europe/Paris' });
  const burn = (hours, power = 3) => {
    for (let i = 0; i <= hours * 12; i++) { c.observe({ t: clock.t, status: 'heating', power, errorCode: 0 }); clock.t += 5 * 60e3; }
    c.observe({ t: clock.t, status: 'off', power, errorCode: 0 });
  };
  burn(3);
  c.refilled({ remainingPercent: 50 }); // install level unknown: no learning
  assert.strictEqual(c.pelletState().factorSamples, 0);
  assert.strictEqual(c.pelletState().known, true);
  burn(4); // model ≈ 1.64 × 4 = 6.6 kg, but 9.5 kg really gone (50 % left)
  c.refilled({ remainingPercent: 50 });
  const st = c.pelletState();
  assert.strictEqual(st.factorSamples, 0.5);
  assert.ok(st.factor > 1.05 && st.factor < 1.3, `factor ${st.factor}`);
  assert.strictEqual(st.refills[0].remainingPercent, 50);
  assert.throws(() => c.refilled({ remainingPercent: 120 }));
  c.setLevel(40);
  assert.strictEqual(c.pelletState().percent, 40);
});
