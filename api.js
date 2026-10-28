'use strict';

module.exports = {
  async getSources({ homey }) {
    return homey.app.listSources();
  },
  async getStatus({ homey }) {
    return homey.app.getSensorStatus();
  },
};
