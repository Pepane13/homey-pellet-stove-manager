'use strict';

module.exports = {
  async getSources({ homey }) {
    return homey.app.listSources();
  },
  async getStatus({ homey }) {
    return homey.app.getSensorStatus();
  },
  async consumablesAction({ homey, body }) {
    return homey.app.consumablesAction(body || {});
  },
  async getThermostats({ homey }) {
    return homey.app.listThermostats();
  },
  async regulationAction({ homey, body }) {
    return homey.app.regulationAction(body || {});
  },
  async resetLearning({ homey }) {
    return homey.app.resetLearning();
  },
};
