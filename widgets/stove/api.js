'use strict';

module.exports = {
  async getData({ homey }) {
    return homey.app.getWidgetData();
  },
  async setTarget({ homey, body }) {
    return homey.app.setManualTarget(body && body.value);
  },
  async schedule({ homey }) {
    return homey.app.resumeSchedule();
  },
};
