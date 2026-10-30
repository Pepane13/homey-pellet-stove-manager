'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { SensorHub } = require('../lib/sensors');

const NOW = Date.parse('2026-10-28T20:00:00Z');
const fresh = (value, minutesAgo = 5) => ({ value, lastUpdated: new Date(NOW - minutesAgo * 60000).toISOString() });

function setup(devices, config) {
  const mem = {};
  const hub = new SensorHub({
    readDevice: async (id) => {
      if (!devices[id]) throw new Error('Not found');
      return devices[id];
    },
    getConfig: () => config,
    store: { get: (k) => mem[k], set: (k, v) => { mem[k] = v; } },
    now: () => NOW,
  });
  return { hub, mem };
}

const ref = (deviceId, capability = 'measure_temperature', extra = {}) => ({ deviceId, capability, ...extra });

const HOUSE = () => ({
  sejour: { name: 'Météo Séjour', capabilitiesObj: { measure_temperature: fresh(22.4) } },
  salon: { name: 'Météo Salon', capabilitiesObj: { measure_temperature: fresh(21.4) } },
  entree: { name: 'Poêle', capabilitiesObj: { measure_temperature: fresh(21.7) } },
  piscine: { name: 'Météo extérieur Piscine', capabilitiesObj: { measure_temperature: fresh(13.7) } },
  couloir: { name: 'Météo couloir extérieur', capabilitiesObj: { measure_temperature: fresh(15.5) } },
  yr: { name: 'Weather', capabilitiesObj: { measure_temperature: fresh(12.3), 'measure_temperature.min_next_6_hours': fresh(10.6) } },
  stove: { name: 'Poêle salon', capabilitiesObj: { measure_temperature: fresh(99.9) } },
  clim: { name: 'Clim - Séjour', capabilitiesObj: { measure_temperature: fresh(23), onoff: { value: false } } },
});

const CONFIG = {
  comfort: ref('sejour'),
  regulation: ref('entree'),
  outdoor: ref('piscine'),
  outdoorBackup: ref('couloir'),
  forecast: { deviceId: 'yr' },
};

test('reads all roles and computes the comfort/regulation gap', async () => {
  const { hub } = setup(HOUSE(), CONFIG);
  const s = await hub.refresh();
  assert.strictEqual(s.comfort, 22.4);
  assert.strictEqual(s.regulation, 21.7);
  assert.strictEqual(s.gap, 0.7);
  assert.strictEqual(s.outdoor, 13.7);
  assert.strictEqual(s.outdoorSource, 'reference');
  assert.strictEqual(s.forecastMin6h, 10.6);
  assert.deepStrictEqual(s.comfortSources, ['Météo Séjour']);
});

test('averages a secondary comfort sensor with its weight', async () => {
  const { hub } = setup(HOUSE(), { ...CONFIG, comfort2: ref('salon'), comfort2Weight: 0.25 });
  const s = await hub.refresh();
  assert.strictEqual(s.comfort, 22.2); // 22.4 * 0.75 + 21.4 * 0.25
});

test('rejects the stove 99.9 °C value, stale values and devices switched off', async () => {
  const devices = HOUSE();
  devices.entree.capabilitiesObj.measure_temperature = fresh(21.7, 500);
  const { hub } = setup(devices, {
    ...CONFIG,
    comfort: ref('stove'),
    comfort2: ref('clim', 'measure_temperature', { ignoreWhenOff: true }),
  });
  const s = await hub.refresh();
  assert.strictEqual(s.roles.comfort, 'out_of_range');
  assert.strictEqual(s.roles.comfort2, 'device_off');
  assert.strictEqual(s.roles.regulation, 'stale');
  assert.strictEqual(s.comfort, null);
  assert.strictEqual(s.gap, null);
});

test('learns the backup bias and applies it when the reference fails', async () => {
  const devices = HOUSE();
  const { hub, mem } = setup(devices, CONFIG);
  for (let i = 0; i < 12; i++) await hub.refresh(); // 15.5 - 13.7 = 1.8 °C bias
  assert.strictEqual(mem.sensor_learning.outdoorOffset.n, 12);

  const events = [];
  hub.on('sensor_unavailable', (e) => events.push(e));
  delete devices.piscine;
  const s = await hub.refresh();
  assert.strictEqual(s.outdoorSource, 'backup');
  assert.strictEqual(s.outdoorCorrected, true);
  assert.strictEqual(s.outdoor, 13.7);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].role, 'outdoor');
  assert.strictEqual(events[0].replacement, 'Météo couloir extérieur');
});

test('uses the backup uncorrected before enough samples, then the forecast', async () => {
  const devices = HOUSE();
  delete devices.piscine;
  const { hub } = setup(devices, CONFIG);
  let s = await hub.refresh();
  assert.strictEqual(s.outdoorSource, 'backup');
  assert.strictEqual(s.outdoorCorrected, false);
  assert.strictEqual(s.outdoor, 15.5);
  delete devices.couloir;
  s = await hub.refresh();
  assert.strictEqual(s.outdoorSource, 'forecast');
  assert.strictEqual(s.outdoor, 12.3);
});

test('emits a restoration event and stays quiet for unconfigured roles', async () => {
  const devices = HOUSE();
  const { hub } = setup(devices, { comfort: ref('sejour') });
  const events = [];
  hub.on('sensor_unavailable', (e) => events.push(['down', e.role]));
  hub.on('sensor_restored', (e) => events.push(['up', e.role]));
  await hub.refresh();
  const saved = devices.sejour;
  delete devices.sejour;
  await hub.refresh();
  devices.sejour = saved;
  await hub.refresh();
  assert.deepStrictEqual(events, [['down', 'comfort'], ['up', 'comfort']]);
});

test('a steady temperature is not stale while the device reports other values', async () => {
  const devices = HOUSE();
  devices.sejour.capabilitiesObj.measure_temperature = fresh(21.5, 200); // unchanged for 200 min
  devices.sejour.capabilitiesObj.measure_co2 = fresh(650, 4);
  devices.piscine.capabilitiesObj.measure_temperature = fresh(11.1, 200);
  devices.piscine.capabilitiesObj.measure_humidity = fresh(88, 200); // whole module silent
  const { hub } = setup(devices, CONFIG);
  const s = await hub.refresh();
  assert.strictEqual(s.roles.comfort, 'ok');
  assert.strictEqual(s.roles.outdoor, 'stale');
});
