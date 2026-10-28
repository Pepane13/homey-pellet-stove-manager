'use strict';

/**
 * Temperature targets set from Flows (« Reach [21] °C at [06:20] »).
 *
 * The app does not control anything: when the computed start time is reached it raises a
 * « time to start » event, and the Flow switches the thermostat. If the room is already warm
 * enough, the event is raised at the target time with needed = false, so that the Flow can still
 * apply the right mode.
 */

const { nextOccurrence } = require('./thermal');

const MIN = 60 * 1000;
const EXPIRE_AFTER = 30 * MIN; // a target that could not be evaluated is dropped 30 min after its time

class TargetPlanner {

  constructor({ store, now = Date.now, timeZone = () => 'Europe/Paris' }) {
    this.store = store;
    this.now = now;
    this.timeZone = timeZone;
  }

  list() {
    return (this.store.get('heat_targets') || []).slice().sort((a, b) => a.at - b.at);
  }

  _save(list) {
    this.store.set('heat_targets', list);
  }

  /** Adds (or replaces) the target for the next occurrence of hh:mm. */
  add(temperature, hhmm) {
    const at = nextOccurrence(hhmm, this.now(), this.timeZone());
    if (!at) throw new Error(`Invalid time: ${hhmm}`);
    const t = Number(temperature);
    if (!(t >= 5 && t <= 30)) throw new Error(`Invalid temperature: ${temperature}`);
    const list = this.list().filter((x) => x.at !== at);
    const target = { temperature: t, time: hhmm, at, created: this.now() };
    list.push(target);
    this._save(list);
    return target;
  }

  cancel() {
    this._save([]);
  }

  /**
   * Evaluates the pending targets with the planner and returns those whose start time is reached.
   * @param {function(object): ?object} planFor  target -> plan (ThermalLearner.plan result) or null
   */
  evaluate(planFor) {
    const now = this.now();
    const due = [];
    const keep = [];
    let next = null;
    for (const target of this.list()) {
      if (now > target.at + EXPIRE_AFTER) continue;
      const plan = now < target.at ? planFor(target) : null;
      const reached = now >= target.at
        || (plan && (plan.needed ? now >= plan.startAt : now >= target.at - 5 * MIN));
      if (reached) {
        due.push({
          target,
          plan,
          needed: plan ? plan.needed : true,
          reachable: plan ? plan.reachable : false,
          lead: Math.max(0, Math.round((target.at - now) / MIN)),
        });
      } else {
        keep.push(target);
        if (!next) next = { target, plan };
      }
    }
    this._save(keep);
    return { due, next };
  }

}

module.exports = { TargetPlanner };
