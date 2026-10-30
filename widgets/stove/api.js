'use strict';

module.exports = {
  async getData({ homey }) {
    return homey.app.getWidgetData();
  },
  async setTarget({ homey, body }) {
    return homey.app.setManualTarget(body && body.value);
  },
  async program({ homey, body }) {
    return homey.app.setProgram(body && body.id);
  },
  async refill({ homey, body }) {
    const r = body && body.remaining;
    return homey.app.consumablesAction({ action: 'refilled', remaining: r === null || r === undefined || r === '' ? null : Number(r) });
  },
  async schedule({ homey }) {
    return homey.app.resumeSchedule();
  },
};
