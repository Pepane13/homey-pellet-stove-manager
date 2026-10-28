'use strict';

const Homey = require('homey');

class PelletStoveApp extends Homey.App {

  async onInit() {
    this.log('Pellet Stove Manager started');
  }

}

module.exports = PelletStoveApp;
