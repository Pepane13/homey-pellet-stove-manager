'use strict';

/**
 * Pellets, cleaning and professional maintenance.
 *
 * Pellets: the tank (19 kg) is considered full after « Tank refilled ». Consumption is integrated
 * while the stove burns, from the nominal rate of the current power level (0.95 kg/h at level 1,
 * 2.33 kg/h at level 5, Interstoves Diego 9 data) multiplied by a correction factor. The factor is
 * learnt only when the tank really ran empty (« out of pellets » alarm): evening top-ups of a tank
 * that is not empty therefore do not bias the statistics.
 *
 * Daily need is estimated from the outdoor temperature with the model fitted on two seasons of the
 * owner's history (diagnostics 02): heating hours per day = 15.06 − 0.809 T, kg per heating hour =
 * 1.341 − 0.0282 T, with a floor of 0.5 h/day below 19.5 °C.
 *
 * Cleaning: combustion hours since the last cleaning, with a configurable threshold.
 * Maintenance: due 12 months after the last service or at 1,200 hours of the stove's own service
 * counter (reset by the technician), whichever comes first; reminder 30 days or 100 hours before.
 */

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const DEFAULTS = Object.freeze({
  tankKg: 19,
  bagKg: 15,
  bagPrice: 5.49,
  lowKg: 4,
  adviceTime: '21:00',
  morningTime: '08:00',
  adviceMargin: 1.2,
  cleaningHours: 22,
  cleaningPreAlert: 0.8,
  serviceMonths: 12,
  serviceHours: 1200,
  remindDays: 30,
  remindHours: 100,
  midSeasonSweep: false,
});

// Nominal consumption per power level (kg/h), linear between the manufacturer's min and max
const RATE_MIN = 0.95;
const RATE_MAX = 2.33;
const BURNING = new Set(['heating', 'eco', 'ignition']);
const FACTOR_PRIOR_WEIGHT = 2;
const FACTOR_MAX_WEIGHT = 10;

// Normal monthly outdoor temperatures (average 2023–2025 of the owner's history)
const NORMALS = { 1: 8.0, 2: 9.8, 3: 11.9, 4: 15.1, 5: 18.8, 6: 23, 7: 26, 8: 26, 9: 21.5, 10: 16.5, 11: 11.8, 12: 8.9 };

const SEED_JOURNAL = [
  { date: '2024-09-12', type: 'installation', hoursTotal: 0, hoursService: 0, cost: 4507.72, note: 'Installation et mise en service (Interstoves France, Aubagne)' },
  { date: '2025-08-19', type: 'service', hoursTotal: 866, hoursService: 866, cost: 210, note: 'Entretien complet + ramonage' },
  { date: '2026-08-27', type: 'service', hoursTotal: 1723, hoursService: 857, cost: 210, note: 'Entretien complet + ramonage (facture : 1 753 h, erreur de saisie)' },
];

function ratePerHour(power) {
  const p = Math.min(5, Math.max(1, Number(power) || 1));
  return RATE_MIN + ((RATE_MAX - RATE_MIN) * (p - 1)) / 4;
}

/** Expected pellet consumption per day (kg) at a mean outdoor temperature. */
function kgPerDay(outdoor) {
  if (outdoor == null) return null;
  let hours = 15.06 - 0.809 * outdoor;
  if (outdoor < 19.5) hours = Math.max(0.5, hours);
  else hours = Math.max(0, hours);
  hours = Math.min(24, hours);
  return hours * Math.max(0.6, 1.341 - 0.0282 * outdoor);
}

function localParts(t, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(t));
  const g = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: g('year'), month: g('month'), day: g('day'), minutes: g('hour') * 60 + g('minute') };
}

const hhmm = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const round = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const pad = (n) => String(n).padStart(2, '0');
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function addMonths(isoDate, months) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${pad(nm)}-${pad(Math.min(d, daysInMonth(ny, nm)))}`;
}

class Consumables {

  constructor({ store, now = Date.now, timeZone = () => 'Europe/Paris', log = () => {} }) {
    this.store = store;
    this.now = now;
    this.timeZone = timeZone;
    this.log = log;
    this.events = [];
    this.data = this._load();
  }

  _load() {
    const d = this.store.get('consumables') || {};
    const now = this.now();
    return {
      pellets: {
        // full: false until a real refill is recorded (the level at installation is unknown)
        refillAt: now, kgBurned: 0, full: false, factor: { value: 1, n: 0 }, lowNotified: false, empties: [], refills: [], ...d.pellets,
      },
      cleaning: { at: now, hours: 0, notified: false, preNotified: false, ...d.cleaning },
      maintenance: {
        lastDate: '2026-08-27', notifiedSoon: false, notifiedDue: false, journal: SEED_JOURNAL.slice(), ...d.maintenance,
      },
      months: d.months || {},
      daily: { adviceDay: null, monthKey: null, sweepYear: null, ...d.daily },
      last: d.last || null,
      forecast: d.forecast || null,
    };
  }

  _save() {
    this.store.set('consumables', this.data);
  }

  config() {
    return { ...DEFAULTS, ...(this.store.get('consumables_settings') || {}) };
  }

  _emit(type, tokens = {}) {
    this.events.push({ type, tokens });
  }

  /** Events raised since the last call (Flow triggers). */
  takeEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  _monthKey(t) {
    const p = localParts(t, this.timeZone());
    return `${p.year}-${pad(p.month)}`;
  }

  /* ---------------- stove observation ---------------- */

  /**
   * One stove snapshot.
   * @param {{t:number, status:string, power:number, errorCode:number, hoursService:number, hoursTotal:number}} s
   */
  observe(s) {
    const cfg = this.config();
    const last = this.data.last;
    if (last && BURNING.has(last.status)) {
      const dt = Math.min(s.t - last.t, 15 * 60 * 1000) / HOUR; // ignore gaps (stove unreachable)
      if (dt > 0) {
        const kg = ratePerHour(last.power) * this.data.pellets.factor.value * dt;
        this.data.pellets.kgBurned += kg;
        this.data.pellets.modelKg = (this.data.pellets.modelKg || 0) + ratePerHour(last.power) * dt;
        this.data.cleaning.hours += dt;
        const key = this._monthKey(s.t);
        this.data.months[key] = round((this.data.months[key] || 0) + kg, 3);
      }
    }

    // The tank ran empty: learn the real consumption against the model
    if (s.errorCode === 5 && (!last || last.errorCode !== 5)) this._onEmpty(s.t);

    this.data.last = {
      t: s.t, status: s.status, power: s.power, errorCode: s.errorCode, hoursService: s.hoursService, hoursTotal: s.hoursTotal,
    };

    const p = this.pelletState();
    if (p.kgLeft <= cfg.lowKg && !this.data.pellets.lowNotified) {
      this.data.pellets.lowNotified = true;
      this._emit('pellets_low', { kg_left: round(p.kgLeft), percent: p.percent });
    }

    const c = this.cleaningState();
    if (c.hours >= cfg.cleaningHours * cfg.cleaningPreAlert && !this.data.cleaning.preNotified) {
      this.data.cleaning.preNotified = true;
      this._emit('cleaning_soon', { hours: round(c.hours), threshold: cfg.cleaningHours });
    }
    if (c.due && !this.data.cleaning.notified) {
      this.data.cleaning.notified = true;
      this._emit('cleaning_due', { hours: round(c.hours), threshold: cfg.cleaningHours });
    }
    this._checkMaintenance();
    this._save();
  }

  _onEmpty(t) {
    const cfg = this.config();
    const pel = this.data.pellets;
    const model = pel.modelKg || 0;
    const event = { at: t, modelKg: round(model, 2), hoursSinceRefill: round((t - pel.refillAt) / HOUR, 1) };
    // a full tank burnt: tankKg = factor × model consumption
    if (pel.full === true && model >= cfg.tankKg * 0.4) {
      const obs = cfg.tankKg / model;
      if (this._learnFactor(obs, 1)) event.factor = round(obs, 3);
    }
    pel.empties.unshift(event);
    pel.empties.length = Math.min(pel.empties.length, 20);
    pel.kgBurned = cfg.tankKg; // empty
    this.log(`Tank empty: model ${event.modelKg} kg since refill, factor ${round(pel.factor.value, 3)}`);
  }

  /* ---------------- pellets ---------------- */

  /** Learns the consumption factor from an observation (burnt kg / model kg) with a weight. */
  _learnFactor(obs, weight = 1) {
    const f = this.data.pellets.factor;
    if (!(obs > 0.4 && obs < 2.5)) return false;
    const w = Math.min(f.n + FACTOR_PRIOR_WEIGHT, FACTOR_MAX_WEIGHT);
    f.value = (f.value * w + obs * weight) / (w + weight);
    f.n += weight;
    return true;
  }

  /**
   * « Tank refilled »: full tank (no bag tracking). With the level seen before refilling (%), the
   * consumption since the previous full refill is learnt too, with half the weight of an empty tank
   * (a visual estimate is less precise).
   */
  refilled({ remainingPercent = null } = {}) {
    const cfg = this.config();
    const pel = this.data.pellets;
    const rem = remainingPercent === null || remainingPercent === '' ? null : Number(remainingPercent);
    if (rem !== null && !(rem >= 0 && rem <= 100)) throw new Error(`Invalid level: ${remainingPercent}`);
    const model = pel.modelKg || 0;
    const entry = {
      at: this.now(), remainingPercent: rem, estimatedPercent: Math.round((Math.max(0, cfg.tankKg - pel.kgBurned) / cfg.tankKg) * 100), modelKg: round(model, 2),
    };
    if (rem !== null && pel.full === true && model >= cfg.tankKg * 0.25) {
      const obs = (cfg.tankKg * (1 - rem / 100)) / model;
      if (this._learnFactor(obs, 0.5)) entry.factor = round(obs, 3);
    }
    pel.refills = [entry, ...(pel.refills || [])].slice(0, 20);
    this.log(`Refill: seen ${rem == null ? '?' : rem} %, estimated ${entry.estimatedPercent} %${entry.factor ? `, factor ${entry.factor}` : ''}`);
    pel.refillAt = this.now();
    pel.kgBurned = 0;
    pel.modelKg = 0;
    pel.full = true;
    pel.lowNotified = false;
    this._save();
  }

  /** « The tank is at [x] % »: corrects the estimated level (no learning). */
  setLevel(percent) {
    const v = Number(percent);
    if (!(v >= 0 && v <= 100)) throw new Error(`Invalid level: ${percent}`);
    const cfg = this.config();
    this.data.pellets.kgBurned = cfg.tankKg * (1 - v / 100);
    if (v > (cfg.lowKg / cfg.tankKg) * 100) this.data.pellets.lowNotified = false;
    this._save();
  }

  setBagPrice(price) {
    const v = Number(price);
    if (!(v > 0 && v < 100)) throw new Error(`Invalid bag price: ${price}`);
    const s = this.store.get('consumables_settings') || {};
    this.store.set('consumables_settings', { ...s, bagPrice: v });
  }

  pelletState(outdoor = null) {
    const cfg = this.config();
    const pel = this.data.pellets;
    const kgLeft = Math.max(0, cfg.tankKg - pel.kgBurned);
    const daily = kgPerDay(outdoor);
    const hoursLeft = daily ? (kgLeft / (daily / 24)) : null;
    return {
      kgLeft: round(kgLeft, 1),
      percent: Math.round((kgLeft / cfg.tankKg) * 100),
      factor: round(pel.factor.value, 3),
      factorSamples: round(pel.factor.n, 1),
      known: pel.full === true,
      refills: (pel.refills || []).slice(0, 5),
      refillAt: pel.refillAt,
      emptyAt: hoursLeft != null && hoursLeft < 24 * 14 ? this.now() + hoursLeft * HOUR : null,
      kgPerDay: round(daily),
      empties: pel.empties.slice(0, 5),
    };
  }

  /** Expected need between now and a time, at the given outdoor temperature. */
  needUntil(at, outdoor) {
    const daily = kgPerDay(outdoor);
    if (daily == null) return null;
    return (daily / 24) * Math.max(0, (at - this.now()) / HOUR);
  }

  /* ---------------- cleaning ---------------- */

  cleaningState() {
    const cfg = this.config();
    const h = this.data.cleaning.hours;
    return { hours: round(h), threshold: cfg.cleaningHours, due: h >= cfg.cleaningHours, at: this.data.cleaning.at };
  }

  cleaned() {
    this.data.cleaning = { at: this.now(), hours: 0, notified: false, preNotified: false };
    this._save();
  }

  /* ---------------- maintenance ---------------- */

  maintenanceState() {
    const cfg = this.config();
    const m = this.data.maintenance;
    const hp = this.data.last ? this.data.last.hoursService : null;
    const dueDate = addMonths(m.lastDate, cfg.serviceMonths);
    const p = localParts(this.now(), this.timeZone());
    const today = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
    const daysLeft = Math.round((Date.parse(dueDate) - Date.parse(today)) / DAY);
    const hoursLeft = hp != null ? cfg.serviceHours - hp : null;
    // date at which the hour limit is expected, from the average burn rate since the last service
    let hoursDueDate = null;
    const since = (Date.parse(today) - Date.parse(m.lastDate)) / DAY;
    if (hp != null && hp > 20 && since > 30) {
      const perDay = hp / since;
      const d = new Date(Date.parse(today) + (hoursLeft / perDay) * DAY);
      hoursDueDate = d.toISOString().slice(0, 10);
    }
    const effective = hoursDueDate && hoursDueDate < dueDate ? hoursDueDate : dueDate;
    return {
      lastDate: m.lastDate,
      dueDate,
      daysLeft,
      hoursService: hp,
      hoursLeft,
      hoursDueDate,
      nextDate: effective,
      due: daysLeft <= 0 || (hoursLeft != null && hoursLeft <= 0),
      soon: daysLeft <= cfg.remindDays || (hoursLeft != null && hoursLeft <= cfg.remindHours),
      journal: m.journal.slice().sort((a, b) => (a.date < b.date ? 1 : -1)),
    };
  }

  _checkMaintenance() {
    const m = this.data.maintenance;
    const s = this.maintenanceState();
    const tokens = { date: s.dueDate, days_left: s.daysLeft, hours_left: s.hoursLeft ?? -1 };
    if (s.due && !m.notifiedDue) {
      m.notifiedDue = true;
      this._emit('maintenance_due', tokens);
    } else if (s.soon && !s.due && !m.notifiedSoon) {
      m.notifiedSoon = true;
      this._emit('maintenance_soon', tokens);
    }
  }

  /** « Maintenance done » (the technician resets the stove's service counter). */
  serviced({ date = null, note = '', cost = null } = {}) {
    const p = localParts(this.now(), this.timeZone());
    const d = date || `${p.year}-${pad(p.month)}-${pad(p.day)}`;
    const last = this.data.last || {};
    this.data.maintenance.journal.push({
      date: d, type: 'service', hoursTotal: last.hoursTotal ?? null, hoursService: last.hoursService ?? null, cost, note,
    });
    Object.assign(this.data.maintenance, { lastDate: d, notifiedSoon: false, notifiedDue: false });
    this._save();
  }

  /* ---------------- scheduled checks (every minute) ---------------- */

  tick(outdoor) {
    const cfg = this.config();
    const t = this.now();
    const p = localParts(t, this.timeZone());
    const dayKey = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
    const d = this.data.daily;

    // Evening refill advice
    const advice = hhmm(cfg.adviceTime);
    if (advice != null && p.minutes >= advice && d.adviceDay !== dayKey) {
      d.adviceDay = dayKey;
      const morning = hhmm(cfg.morningTime) ?? 480;
      const untilMorning = ((24 * 60 - p.minutes) + morning) * 60 * 1000;
      const need = this.needUntil(t + untilMorning, outdoor);
      const st = this.pelletState(outdoor);
      const tokens = { kg_left: st.kgLeft, kg_needed: round(need ?? 0), percent: st.percent };
      if (need != null && st.kgLeft < need * cfg.adviceMargin) this._emit('pellets_refill_advised', tokens);
      else this._emit('pellets_refill_not_needed', tokens);
    }

    // Monthly forecast, on the first day of the month
    const monthKey = `${p.year}-${pad(p.month)}`;
    if (d.monthKey !== monthKey && p.minutes >= 9 * 60) {
      d.monthKey = monthKey;
      const f = this.monthForecast(p.year, p.month);
      this.data.forecast = f;
      if (f.kg > 0 && p.day === 1) this._emit('monthly_forecast', { month: f.label, bags: f.bags, kg: f.kg, cost: f.cost });
    }

    // Optional mid-season chimney sweeping reminder (mid-January)
    if (cfg.midSeasonSweep && p.month === 1 && p.day >= 15 && d.sweepYear !== p.year && p.minutes >= 9 * 60) {
      d.sweepYear = p.year;
      this._emit('chimney_sweep_reminder', {});
    }
    this._save();
  }

  /** Expected consumption of a month at its normal temperature, corrected by the learnt factor. */
  monthForecast(year, month) {
    const cfg = this.config();
    const normal = NORMALS[month];
    const days = daysInMonth(year, month);
    const kg = Math.round((kgPerDay(normal) || 0) * days * this.data.pellets.factor.value);
    const bags = Math.ceil(kg / cfg.bagKg);
    const label = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' })
      .format(new Date(Date.UTC(year, month - 1, 15)));
    return { year, month, label, normal, kg, bags, cost: round(bags * cfg.bagPrice, 2), price: cfg.bagPrice };
  }

  monthSummary() {
    const cfg = this.config();
    const key = this._monthKey(this.now());
    const kg = this.data.months[key] || 0;
    return {
      key,
      kg: round(kg, 1),
      bags: round(kg / cfg.bagKg, 1),
      cost: round((kg / cfg.bagKg) * cfg.bagPrice, 2),
      forecast: this.data.forecast,
      history: Object.entries(this.data.months).sort(([a], [b]) => (a < b ? -1 : 1)).slice(-24)
        .map(([k, v]) => ({ month: k, kg: round(v, 1), cost: round((v / cfg.bagKg) * cfg.bagPrice, 2) })),
    };
  }

  summary(outdoor = null) {
    return {
      config: this.config(),
      pellets: this.pelletState(outdoor),
      cleaning: this.cleaningState(),
      maintenance: this.maintenanceState(),
      month: this.monthSummary(),
    };
  }

}

module.exports = { Consumables, ratePerHour, kgPerDay, addMonths, DEFAULTS, NORMALS };
