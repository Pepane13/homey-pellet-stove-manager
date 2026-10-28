'use strict';

/**
 * Hourly temperature forecast from Météo-France models (AROME HD 1.5 km / AROME 2.5 km / ARPEGE,
 * blended by Open-Meteo as "meteofrance_seamless"). Free for non-commercial use, no API key.
 *
 * The Homey location is rounded to 2 decimals (~1 km) before being sent.
 * The forecast is refreshed every hour (AROME runs every 3 hours) and kept for 6 hours
 * if the service becomes unreachable.
 */

const ENDPOINT = 'https://api.open-meteo.com/v1/meteofrance';
const REFRESH_MS = 60 * 60 * 1000;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const HOUR = 3600 * 1000;

/** Linear interpolation of the hourly series at time t (ms). */
function valueAt(series, t) {
  const { times, temps } = series;
  if (!times.length || t < times[0] || t > times[times.length - 1]) return null;
  for (let i = 1; i < times.length; i++) {
    if (t <= times[i]) {
      const a = temps[i - 1];
      const b = temps[i];
      if (a == null || b == null) return a ?? b ?? null;
      return a + ((b - a) * (t - times[i - 1])) / (times[i] - times[i - 1]);
    }
  }
  return temps[temps.length - 1];
}

/** Minimum between t and t + hours, including the interpolated value at t. */
function minOver(series, t, hours) {
  const end = t + hours * HOUR;
  let min = valueAt(series, t);
  series.times.forEach((ti, i) => {
    const v = series.temps[i];
    if (ti > t && ti <= end && v != null && (min == null || v < min)) min = v;
  });
  return min;
}

class MeteoFranceForecast {

  /**
   * @param {object} opts
   * @param {function(): {latitude:number, longitude:number}} opts.getLocation
   * @param {function(string): Promise<object>} [opts.fetchJson]
   * @param {{get: function, set: function}} [opts.store] persists the last forecast across restarts
   */
  constructor({ getLocation, fetchJson, store, now = Date.now, log = () => {} }) {
    this.getLocation = getLocation;
    this.fetchJson = fetchJson || MeteoFranceForecast.defaultFetch;
    this.store = store;
    this.now = now;
    this.log = log;
    this.series = (store && store.get('forecast_meteofrance')) || null;
    this.lastAttempt = 0;
    this.lastError = null;
  }

  static async defaultFetch(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'PelletStoveManager-Homey' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  url() {
    const loc = this.getLocation() || {};
    const lat = Number(loc.latitude);
    const lon = Number(loc.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) {
      throw new Error('Homey location unknown');
    }
    const q = new URLSearchParams({
      latitude: lat.toFixed(2),
      longitude: lon.toFixed(2),
      hourly: 'temperature_2m',
      models: 'meteofrance_seamless',
      forecast_days: '2',
      timeformat: 'unixtime',
      timezone: 'UTC',
    });
    return `${ENDPOINT}?${q}`;
  }

  /** Refresh if the forecast is older than one hour (at most one attempt every 10 minutes). */
  async update(force = false) {
    const t = this.now();
    const fresh = this.series && t - this.series.fetchedAt < REFRESH_MS;
    if (!force && (fresh || t - this.lastAttempt < 10 * 60 * 1000)) return this.series;
    this.lastAttempt = t;
    try {
      const json = await this.fetchJson(this.url());
      const h = json && json.hourly;
      if (!h || !Array.isArray(h.time) || !Array.isArray(h.temperature_2m) || !h.time.length) {
        throw new Error('Unexpected forecast format');
      }
      this.series = {
        fetchedAt: t,
        times: h.time.map((s) => s * 1000),
        temps: h.temperature_2m.map((v) => (typeof v === 'number' ? v : null)),
        elevation: json.elevation ?? null,
      };
      this.lastError = null;
      if (this.store) this.store.set('forecast_meteofrance', this.series);
    } catch (err) {
      this.lastError = err.message;
      this.log(`Météo-France forecast unavailable: ${err.message}`);
    }
    return this.series;
  }

  /** Current value, 6-hour minimum and the hourly curve, or null if no usable forecast. */
  current() {
    const t = this.now();
    if (!this.series || t - this.series.fetchedAt > MAX_AGE_MS) return null;
    const now = valueAt(this.series, t);
    if (now == null) return null;
    return {
      source: 'meteofrance',
      name: 'Météo-France (AROME)',
      now,
      min6h: minOver(this.series, t, 6),
      fetchedAt: this.series.fetchedAt,
      series: this.series,
    };
  }

}

module.exports = { MeteoFranceForecast, valueAt, minOver };
