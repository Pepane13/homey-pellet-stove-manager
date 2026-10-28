'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MeteoFranceForecast, valueAt, minOver } = require('../lib/forecast');
const { SensorHub } = require('../lib/sensors');

const NOW = Date.parse('2026-10-28T20:30:00Z');
const H = 3600;
const T0 = Date.parse('2026-10-28T00:00:00Z') / 1000;

// 48 hourly values: 12 °C at 20:00 UTC dropping 0.5 °C per hour until 04:00, then rising
function openMeteoResponse() {
  const time = [];
  const temperature_2m = [];
  for (let i = 0; i < 48; i++) {
    time.push(T0 + i * H);
    const fromEight = i - 20;
    temperature_2m.push(fromEight <= 8 ? 12 - 0.5 * fromEight : 8 + 0.5 * (fromEight - 8));
  }
  return { latitude: 43.3, longitude: 5.4, elevation: 60, hourly: { time, temperature_2m } };
}

function provider({ fetchJson, now = () => NOW, location = { latitude: 43.29876, longitude: 5.41234 } } = {}) {
  const mem = {};
  const urls = [];
  const p = new MeteoFranceForecast({
    getLocation: () => location,
    fetchJson: async (url) => { urls.push(url); return fetchJson ? fetchJson(url) : openMeteoResponse(); },
    store: { get: (k) => mem[k], set: (k, v) => { mem[k] = v; } },
    now,
  });
  return { p, urls, mem };
}

test('interpolates the hourly series and finds the 6-hour minimum', () => {
  const series = { times: [0, 3600e3, 7200e3], temps: [10, 8, 9] };
  assert.strictEqual(valueAt(series, 1800e3), 9);
  assert.strictEqual(valueAt(series, 9000e3), null);
  assert.strictEqual(minOver(series, 0, 6), 8);
});

test('requests the Météo-France model with a location rounded to ~1 km', async () => {
  const { p, urls } = provider();
  await p.update();
  assert.strictEqual(urls.length, 1);
  const u = new URL(urls[0]);
  assert.strictEqual(u.pathname, '/v1/meteofrance');
  assert.strictEqual(u.searchParams.get('latitude'), '43.30');
  assert.strictEqual(u.searchParams.get('longitude'), '5.41');
  assert.strictEqual(u.searchParams.get('models'), 'meteofrance_seamless');
  const c = p.current();
  assert.strictEqual(c.now, 11.75); // 20:30 between 12 and 11.5
  assert.strictEqual(c.min6h, 9); // 02:00
});

test('caches for an hour and keeps the last forecast when the service fails', async () => {
  let t = NOW;
  let fail = false;
  const { p, urls } = provider({ now: () => t, fetchJson: () => { if (fail) throw new Error('HTTP 503'); return openMeteoResponse(); } });
  await p.update();
  t += 30 * 60e3;
  await p.update();
  assert.strictEqual(urls.length, 1);
  fail = true;
  t += 40 * 60e3;
  await p.update();
  assert.strictEqual(urls.length, 2);
  assert.strictEqual(p.lastError, 'HTTP 503');
  assert.ok(p.current(), 'old forecast still usable');
  t += 6 * 3600e3;
  assert.strictEqual(p.current(), null, 'too old after 6 hours');
});

test('reports an unknown Homey location without calling the service', async () => {
  const { p, urls } = provider({ location: { latitude: 0, longitude: 0 } });
  await p.update();
  assert.strictEqual(urls.length, 0);
  assert.match(p.lastError, /location/);
  assert.strictEqual(p.current(), null);
});

function hubWith(forecastProvider, forecastSource, devices) {
  const mem = {};
  const fresh = (value) => ({ value, lastUpdated: new Date(NOW - 5 * 60e3).toISOString() });
  const all = devices || {
    sejour: { name: 'Séjour', capabilitiesObj: { measure_temperature: fresh(21) } },
    piscine: { name: 'Piscine', capabilitiesObj: { measure_temperature: fresh(11.5) } },
    yr: { name: 'Weather', capabilitiesObj: { measure_temperature: fresh(13), 'measure_temperature.min_next_6_hours': fresh(10.6) } },
  };
  const hub = new SensorHub({
    readDevice: async (id) => { if (!all[id]) throw new Error('Not found'); return all[id]; },
    getConfig: () => ({ comfort: { deviceId: 'sejour', capability: 'measure_temperature' }, outdoor: { deviceId: 'piscine', capability: 'measure_temperature' }, forecast: { deviceId: 'yr' }, forecastSource }),
    store: { get: (k) => mem[k], set: (k, v) => { mem[k] = v; } },
    forecastProvider,
    now: () => NOW,
  });
  return { hub, mem };
}

test('sensor hub uses Météo-France when selected and tracks both forecasts', async () => {
  const { p } = provider();
  const { hub } = hubWith(p, 'meteofrance');
  const s = await hub.refresh();
  assert.strictEqual(s.forecastSource, 'meteofrance');
  assert.strictEqual(s.forecastMin6h, 9);
  assert.strictEqual(s.forecastFallback, false);
  assert.deepStrictEqual(s.forecastAccuracy.meteofrance, { mae: 0.3, bias: 0.3, samples: 1 });
  assert.deepStrictEqual(s.forecastAccuracy.device, { mae: 1.5, bias: 1.5, samples: 1 });
  await hub.refresh(); // same hour: no new sample
  assert.strictEqual(hub.forecastAccuracy().meteofrance.samples, 1);
});

test('sensor hub falls back to the weather device when Météo-France is unavailable', async () => {
  const { p } = provider({ fetchJson: () => { throw new Error('offline'); } });
  const { hub } = hubWith(p, 'meteofrance');
  const s = await hub.refresh();
  assert.strictEqual(s.forecastSource, 'device');
  assert.strictEqual(s.forecastMin6h, 10.6);
  assert.strictEqual(s.forecastFallback, true);
  assert.strictEqual(s.forecastError, 'offline');
});

test('sensor hub does not call Météo-France when the device source is selected', async () => {
  const { p, urls } = provider();
  const { hub } = hubWith(p, 'device');
  const s = await hub.refresh();
  assert.strictEqual(urls.length, 0);
  assert.strictEqual(s.forecastSource, 'device');
});
