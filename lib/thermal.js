'use strict';

/**
 * Thermal learning and heat-up anticipation.
 *
 * Model, per indoor sensor (comfort and regulation):
 *   stove off:   dT/dt = -k (T - Tout)
 *   stove on:    dT/dt = G - k (T - Tout), after an ignition lag L
 *   k  losses (°C/h per K of indoor-outdoor difference), learnt on quiet nights, stove off
 *   G  heating gain (°C/h), learnt on each heat-up
 *   L  lag between stove start and the first measurable rise (minutes)
 *
 * Starting values come from the stove model (diagnostics 02): losses 0.012 / 0.007 °C/h/K,
 * net rise 0.5 / 0.2 °C/h (comfort / regulation), and count as a few observations so that the
 * first real measurements move the estimate without overriding it.
 *
 * Exclusions: daytime cooling (sun, occupancy), heat-ups started between 10:00 and 16:00 (sun),
 * sudden drops (window open), implausible results and outliers against the current estimate.
 */

const HOUR = 3600 * 1000;
const MIN = 60 * 1000;

const SENSORS = ['comfort', 'regulation'];
const PRIORS = {
  comfort: { k: 0.012, gain: 0.62, lag: 30 },
  regulation: { k: 0.007, gain: 0.27, lag: 40 },
};
const PRIOR_WEIGHT = 3; // the starting value counts as 3 observations
const MAX_WEIGHT = 20; // then behaves like a moving average over ~20 observations

const HEAT_STATES = new Set(['ignition', 'heating', 'eco']);
const OFF_STATES = new Set(['off']);

const LIMITS = {
  k: [0.001, 0.08],
  gain: [0.05, 4],
  lag: [0, 150],
};

const COOLING = {
  settleMinutes: 60, // residual heat of the stove after it stopped
  minHours: 3,
  minDelta: 5, // K between indoor and outdoor, below that the measure is too noisy
  nightFrom: 21,
  nightTo: 8,
  maxSegmentHours: 10,
};
const HEATING = {
  minMinutes: 45,
  minRiseMinutes: 30,
  maxRiseHours: 3,
  rise: 0.2, // °C above the start temperature marking the end of the lag
  sunFrom: 10,
  sunTo: 16,
};
const WINDOW_DROP = 0.3; // °C lost within 10 minutes: window or door open

const HISTORY = 40;
const NIGHTS = 500; // nightly loss measurements kept for the insulation curve (several seasons)
const LOSS_SCALE = 10; // losses shown as °C lost per hour for a 10 °C indoor/outdoor difference

/** Local hour (0-23, fractional) of a timestamp in a time zone. */
function localTime(t, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(t));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return get('hour') + get('minute') / 60;
}

function inHours(h, from, to) {
  return from <= to ? h >= from && h < to : h >= from || h < to;
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const round = (v, d) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

/** Largest drop of value within any 10-minute span. */
function maxDrop(samples, key) {
  let worst = 0;
  let j = 0;
  for (let i = 0; i < samples.length; i++) {
    while (samples[i].t - samples[j].t > 10 * MIN) j += 1;
    for (let m = j; m < i; m++) {
      const d = samples[m][key] - samples[i][key];
      if (d > worst) worst = d;
    }
  }
  return worst;
}

class ThermalLearner {

  /**
   * @param {object} opts
   * @param {{get: function, set: function}} opts.store
   * @param {function(): string} [opts.timeZone]
   */
  constructor({ store, timeZone = () => 'Europe/Paris', now = Date.now, log = () => {} }) {
    this.store = store;
    this.timeZone = timeZone;
    this.now = now;
    this.log = log;
    this.segment = null; // { phase, start, samples[] }
    this.data = this._load();
  }

  _load() {
    const saved = (this.store && this.store.get('thermal_learning')) || {};
    const params = {};
    for (const s of SENSORS) {
      params[s] = {};
      for (const p of ['k', 'gain', 'lag']) {
        const v = saved.params && saved.params[s] && saved.params[s][p];
        params[s][p] = v && typeof v.value === 'number' ? v : { value: PRIORS[s][p], n: 0 };
      }
    }
    const history = Array.isArray(saved.history) ? saved.history : [];
    let nights = Array.isArray(saved.nights) ? saved.nights : null;
    if (!nights) {
      // 0.3.1 kept no curve: rebuild it from the accepted nights of the journal
      const byDate = {};
      history.filter((e) => e.type === 'cooling' && e.accepted && e.value != null).forEach((e) => {
        const at = e.at - 12 * HOUR; // measured in the morning, belongs to the previous evening
        const date = localDate(at, this.timeZone());
        const n = byDate[date] || (byDate[date] = { date, at, hours: e.hours, outdoor: e.outdoor });
        n[e.sensor] = round(e.value * LOSS_SCALE, 3);
      });
      nights = Object.values(byDate).sort((a, b) => a.at - b.at);
    }
    return { params, history, nights };
  }

  _save() {
    if (this.store) this.store.set('thermal_learning', this.data);
  }

  param(sensor, name) {
    return this.data.params[sensor][name].value;
  }

  /** Back to the starting values; the nightly loss curve is kept (insulation follow-up). */
  reset() {
    const { nights } = this.data;
    this.store.set('thermal_learning', { nights });
    this.data = this._load();
    this.segment = null;
  }

  /* ---------------- observation ---------------- */

  /**
   * One sample per minute or so.
   * @param {{t:number, comfort:?number, regulation:?number, outdoor:?number, stove:?string}} s
   */
  observe(s) {
    const phase = s.stove == null ? 'unknown' : HEAT_STATES.has(s.stove) ? 'heating' : OFF_STATES.has(s.stove) ? 'off' : 'other';
    if (!this.segment || this.segment.phase !== phase) {
      this._close();
      this.segment = { phase, start: s.t, previous: this.segment ? this.segment.phase : null, samples: [] };
    }
    if (s.outdoor != null) this.segment.samples.push(s);
    // A long night with the stove off is analysed without waiting for the next start
    if (phase === 'off' && s.t - this.segment.start > COOLING.maxSegmentHours * HOUR) {
      this._close();
      this.segment = { phase, start: s.t, previous: 'off', samples: [], settled: true };
    }
  }

  _close() {
    const seg = this.segment;
    if (!seg || !seg.samples.length) return;
    try {
      if (seg.phase === 'off') this._analyseCooling(seg);
      if (seg.phase === 'heating') this._analyseHeating(seg);
    } catch (err) {
      this.log(`Thermal analysis failed: ${err.message}`);
    }
  }

  _record(event) {
    this.data.history.unshift({ at: this.now(), ...event });
    this.data.history.length = Math.min(this.data.history.length, HISTORY);
  }

  /** Weighted update with outlier rejection. Returns true if accepted. */
  _update(sensor, name, x) {
    const [lo, hi] = LIMITS[name];
    if (!(x >= lo && x <= hi)) return 'implausible';
    const cur = this.data.params[sensor][name];
    if (cur.n >= 5 && name !== 'lag' && (x > cur.value * 2.5 || x < cur.value / 2.5)) return 'outlier';
    if (cur.n >= 5 && name === 'lag' && Math.abs(x - cur.value) > 60) return 'outlier';
    const w = Math.min(cur.n + PRIOR_WEIGHT, MAX_WEIGHT);
    cur.value = (cur.value * w + x) / (w + 1);
    cur.n += 1;
    return null;
  }

  _analyseCooling(seg) {
    const tz = this.timeZone();
    const from = seg.start + (seg.settled || seg.previous === 'off' ? 0 : COOLING.settleMinutes * MIN);
    // longest run of night samples after the settling time
    let best = [];
    let run = [];
    for (const s of seg.samples) {
      if (s.t >= from && inHours(localTime(s.t, tz), COOLING.nightFrom, COOLING.nightTo)) {
        run.push(s);
      } else {
        if (run.length > best.length) best = run;
        run = [];
      }
    }
    if (run.length > best.length) best = run;
    if (!best.length) return;
    const hours = (best[best.length - 1].t - best[0].t) / HOUR;
    if (hours < COOLING.minHours) return;

    const night = { date: localDate(best[0].t, tz), at: best[0].t, hours: round(hours, 1) };
    for (const sensor of SENSORS) {
      const pts = best.filter((s) => s[sensor] != null);
      if (pts.length < 10) continue;
      const head = pts.filter((s) => s.t - pts[0].t <= 15 * MIN);
      const tail = pts.filter((s) => pts[pts.length - 1].t - s.t <= 15 * MIN);
      const t0 = mean(head.map((s) => s[sensor]));
      const t1 = mean(tail.map((s) => s[sensor]));
      const out = mean(pts.map((s) => s.outdoor));
      const h = (mean(tail.map((s) => s.t)) - mean(head.map((s) => s.t))) / HOUR;
      const base = { type: 'cooling', sensor, hours: round(hours, 1), from: round(t0, 1), to: round(t1, 1), outdoor: round(out, 1) };
      let reason = null;
      if (t0 - out < COOLING.minDelta || t1 - out < 2) reason = 'small_delta';
      else if (maxDrop(pts, sensor) > WINDOW_DROP) reason = 'window';
      else if (t1 > t0 + 0.2) reason = 'warming';
      let k = null;
      if (!reason) {
        k = Math.log((t0 - out) / (t1 - out)) / h;
        reason = this._update(sensor, 'k', k);
      }
      this._record({ ...base, value: round(k, 4), accepted: !reason, reason });
      // the insulation curve keeps every physically valid night, even one far from the estimate
      if (k != null && (!reason || reason === 'outlier')) {
        night[sensor] = round(k * LOSS_SCALE, 3);
        night.outdoor = round(out, 1);
        night[`${sensor}Delta`] = round((t0 + t1) / 2 - out, 1);
      }
    }
    if (night.comfort != null || night.regulation != null) {
      this.data.nights = this.data.nights.filter((n) => n.date !== night.date);
      this.data.nights.push(night);
      if (this.data.nights.length > NIGHTS) this.data.nights.splice(0, this.data.nights.length - NIGHTS);
      if (this.onNight) this.onNight(night, this.lossSummary());
    }
    this._save();
  }

  _analyseHeating(seg) {
    const tz = this.timeZone();
    const pts0 = seg.samples;
    const minutes = (pts0[pts0.length - 1].t - seg.start) / MIN;
    if (minutes < HEATING.minMinutes) return;
    const startHour = localTime(seg.start, tz);
    const sunny = inHours(startHour, HEATING.sunFrom, HEATING.sunTo);

    for (const sensor of SENSORS) {
      const pts = pts0.filter((s) => s[sensor] != null);
      if (pts.length < 10) continue;
      const start = mean(pts.filter((s) => s.t - pts[0].t <= 5 * MIN).map((s) => s[sensor]));
      const base = { type: 'heating', sensor, minutes: Math.round(minutes), from: round(start, 1) };
      const rising = pts.find((s) => s[sensor] >= start + HEATING.rise);
      if (!rising) {
        this._record({ ...base, accepted: false, reason: 'no_rise' });
        continue;
      }
      const lag = (rising.t - seg.start) / MIN;
      // rise until the stove modulates near the setpoint (0.2 °C below the maximum) or 3 h
      const top = Math.max(...pts.map((s) => s[sensor]));
      const end = pts.find((s) => s.t > rising.t && (s[sensor] >= top - 0.2 || s.t - rising.t >= HEATING.maxRiseHours * HOUR));
      const reasons = [];
      if (sunny) reasons.push('sun');
      if (maxDrop(pts, sensor) > WINDOW_DROP) reasons.push('window');
      if (!end || (end.t - rising.t) / MIN < HEATING.minRiseMinutes) reasons.push('short');
      let gain = null;
      if (!reasons.length) {
        const span = pts.filter((s) => s.t >= rising.t && s.t <= end.t);
        const h = (end.t - rising.t) / HOUR;
        const net = (end[sensor] - rising[sensor]) / h;
        const deficit = mean(span.map((s) => s[sensor] - s.outdoor));
        gain = net + this.param(sensor, 'k') * deficit;
        const r1 = this._update(sensor, 'gain', gain);
        const r2 = r1 ? null : this._update(sensor, 'lag', lag);
        if (r1 || r2) reasons.push(r1 || r2);
        Object.assign(base, { rise: round(net, 2), outdoor: round(mean(span.map((s) => s.outdoor)), 1) });
      }
      this._record({
        ...base, to: round(end ? end[sensor] : top, 1), value: round(gain, 2), lag: Math.round(lag), accepted: !reasons.length, reason: reasons[0] || null,
      });
    }
    this._save();
  }

  /* ---------------- anticipation ---------------- */

  /**
   * Latest stove start that brings the sensor to the target temperature at the target time.
   * @param {object} p
   * @param {'comfort'|'regulation'} p.sensor
   * @param {number} p.target °C
   * @param {number} p.at timestamp
   * @param {number} p.current current temperature of the sensor
   * @param {function(number): number} p.outdoorAt outdoor temperature expected at a timestamp
   * @param {boolean} [p.heating] stove already heating
   */
  plan({ sensor, target, at, current, outdoorAt, heating = false }) {
    const now = this.now();
    const k = this.param(sensor, 'k');
    const G = this.param(sensor, 'gain');
    const lag = heating ? 0 : this.param(sensor, 'lag');
    const step = 5 * MIN;
    if (current == null || at <= now) return null;

    const simulate = (startAt) => {
      let T = current;
      for (let t = now; t < at; t += step) {
        const dt = Math.min(step, at - t) / HOUR;
        const on = t >= startAt + lag * MIN;
        T += ((on ? G : 0) - k * (T - outdoorAt(t))) * dt;
      }
      return T;
    };

    const base = { sensor, target, at, current: round(current, 1), k: round(k, 4), gain: round(G, 2), lag: Math.round(lag) };
    const noHeat = simulate(Infinity);
    if (noHeat >= target) return { ...base, needed: false, startAt: null, minutes: 0, reachable: true, expected: round(noHeat, 1) };
    for (let s = Math.floor((at - step) / step) * step; s >= now; s -= step) {
      const T = simulate(s);
      if (T >= target) {
        return { ...base, needed: true, startAt: s, minutes: Math.round((at - s) / MIN), reachable: true, expected: round(T, 1) };
      }
    }
    const best = simulate(now);
    return { ...base, needed: true, startAt: now, minutes: Math.round((at - now) / MIN), reachable: false, expected: round(best, 1) };
  }

  /**
   * Insulation follow-up: nightly losses (°C/h for 10 °C of difference), rolling median of the last
   * 14 nights, and before/after comparison around the date of the works when given.
   */
  lossSummary(worksDate = null) {
    const nights = this.data.nights.slice().sort((a, b) => a.at - b.at);
    const med = (xs) => {
      const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
      if (!v.length) return null;
      const m = Math.floor(v.length / 2);
      return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
    };
    const side = (list) => ({
      nights: list.filter((n) => n.comfort != null).length,
      comfort: round(med(list.map((n) => n.comfort)), 3),
      regulation: round(med(list.map((n) => n.regulation)), 3),
    });
    const out = { nights, recent: side(nights.slice(-14)), scale: LOSS_SCALE };
    if (worksDate) {
      const before = side(nights.filter((n) => n.date < worksDate));
      const after = side(nights.filter((n) => n.date > worksDate));
      const gain = (b, a) => (b && a ? Math.round((1 - a / b) * 100) : null);
      out.works = {
        date: worksDate, before, after,
        gainComfort: gain(before.comfort, after.comfort),
        gainRegulation: gain(before.regulation, after.regulation),
      };
    }
    return out;
  }

  /** Learnt parameters and recent events for the settings page. */
  summary() {
    const params = {};
    for (const s of SENSORS) {
      params[s] = {};
      for (const p of ['k', 'gain', 'lag']) {
        const v = this.data.params[s][p];
        params[s][p] = { value: round(v.value, p === 'k' ? 4 : p === 'gain' ? 2 : 0), samples: v.n, prior: PRIORS[s][p] };
      }
    }
    return { params, history: this.data.history.slice(0, 15), phase: this.segment ? this.segment.phase : null };
  }

}

/** Local calendar date (YYYY-MM-DD) of a timestamp. */
function localDate(t, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}

/** Next occurrence of a local time of day ("HH:MM") after now, in the given time zone. */
function nextOccurrence(hhmm, now, timeZone) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const want = Number(m[1]) * 60 + Number(m[2]);
  const local = localTime(now, timeZone) * 60;
  let diff = want - Math.floor(local);
  if (diff <= 0) diff += 1440;
  const seconds = new Date(now).getUTCSeconds() * 1000 + new Date(now).getUTCMilliseconds();
  return now - seconds + diff * MIN;
}

module.exports = { ThermalLearner, PRIORS, localTime, localDate, nextOccurrence, maxDrop };
