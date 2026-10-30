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
  async consumables({ homey, body }) {
    const action = body && body.action;
    if (!['refilled', 'cleaned'].includes(action)) throw new Error('Unknown action');
    return homey.app.consumablesAction({ action });
  },
  async schedule({ homey }) {
    return homey.app.resumeSchedule();
  },
};
