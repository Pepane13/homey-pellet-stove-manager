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
  async schedule({ homey }) {
    return homey.app.resumeSchedule();
  },
};
