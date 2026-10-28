'use strict';

/**
 * TCP transport to a Duepi EVO stove.
 *
 *  - mode "cloud": connects to the Duepi relay (1.duepiwebserver1.com:3000), logs in with
 *    "master:<code>#" and exchanges AES-encrypted frames. One session is kept open and reused.
 *  - mode "local": plain frames to a serial bridge on the LAN (ESP-Link / ser2net, port 23 or 2000).
 *
 * Commands are strictly serialised: the stove answers one request at a time and a late
 * reply must never be matched to another command. A reply timeout invalidates the session.
 * Consecutive connection failures are spaced by an exponential back-off (5 s to 10 min)
 * to stay gentle with the vendor relay.
 */

const net = require('net');
const { EventEmitter } = require('events');
const codec = require('./codec');

const DEFAULTS = Object.freeze({
  cloudHost: '1.duepiwebserver1.com',
  cloudPort: 3000,
  localPort: 23,
  replyTimeout: 4000,
  connectTimeout: 10000,
  loginDelay: 500,
  interCommandDelay: 150,
  idleClose: 5 * 60 * 1000,
  backoffMin: 5000,
  backoffMax: 10 * 60 * 1000,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class DuepiTransport extends EventEmitter {

  /**
   * @param {object} opts
   * @param {'cloud'|'local'} opts.mode
   * @param {string} [opts.host]
   * @param {number} [opts.port]
   * @param {string} [opts.code] device code (cloud mode)
   * @param {function} [opts.log]
   */
  constructor(opts = {}) {
    super();
    this.mode = opts.mode === 'local' ? 'local' : 'cloud';
    this.host = opts.host || (this.mode === 'cloud' ? DEFAULTS.cloudHost : null);
    this.port = Number(opts.port) || (this.mode === 'cloud' ? DEFAULTS.cloudPort : DEFAULTS.localPort);
    this.code = opts.code ? String(opts.code).trim().replace(/#+$/, '') : null;
    this.opts = { ...DEFAULTS, ...opts };
    this.log = opts.log || (() => {});
    if (!this.host) throw new Error('Host is required');
    if (this.mode === 'cloud') {
      if (!this.code) throw new Error('Device code is required in cloud mode');
      this.key = codec.deriveKey(this.code);
    }
    this.socket = null;
    this.ready = null;
    this.parser = null;
    this.pending = null;
    this.queue = Promise.resolve();
    this.failures = 0;
    this.nextAttempt = 0;
    this.idleTimer = null;
    this.closed = false;
  }

  get connected() {
    return !!this.socket && !this.socket.destroyed;
  }

  /** Send one command and resolve with its 8-character reply payload. */
  request(command) {
    const run = () => this._request(command);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async _request(command) {
    if (this.closed) throw new Error('Transport closed');
    await this._ensureConnected();
    const frame = this.mode === 'cloud' ? codec.encryptFrame(command, this.key) : codec.plainFrame(command);
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        this._drop(new Error(`No reply to ${command}`));
        reject(new Error(`Timeout waiting for reply to ${command}`));
      }, this.opts.replyTimeout);
      this.pending = { command, resolve, reject, timer };
      this.socket.write(frame);
    });
    this._armIdle();
    if (this.opts.interCommandDelay) await sleep(this.opts.interCommandDelay);
    return reply;
  }

  async _ensureConnected() {
    if (this.connected && this.ready) return this.ready;
    const wait = this.nextAttempt - Date.now();
    if (wait > 0) {
      const err = new Error(`Reconnection delayed (${Math.ceil(wait / 1000)} s)`);
      err.code = 'BACKOFF';
      throw err;
    }
    this.ready = this._connect();
    try {
      await this.ready;
      this.failures = 0;
      this.nextAttempt = 0;
    } catch (err) {
      this.ready = null;
      this.failures += 1;
      const delay = Math.min(this.opts.backoffMax, this.opts.backoffMin * 2 ** (this.failures - 1));
      this.nextAttempt = Date.now() + delay;
      this.emit('connection_error', err, delay);
      throw err;
    }
    return this.ready;
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port });
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 30000);
      const parser = new codec.FrameParser(this.key || null);
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error(`Connection timeout to ${this.host}:${this.port}`)), this.opts.connectTimeout);

      socket.once('connect', async () => {
        clearTimeout(timer);
        this.socket = socket;
        this.parser = parser;
        if (this.mode === 'cloud') socket.write(`master:${this.code}#`, 'ascii');
        await sleep(this.opts.loginDelay);
        if (socket.destroyed) return fail(new Error('Connection closed during login'));
        settled = true;
        this.log(`Connected to ${this.host}:${this.port} (${this.mode})`);
        this.emit('connected');
        resolve();
      });
      // Events from a superseded socket must never affect the current session.
      const current = () => this.socket === socket;
      socket.on('data', (chunk) => {
        if (current()) this._onData(chunk);
      });
      socket.on('error', (err) => {
        if (!settled) fail(err);
        else if (current()) this._drop(err);
      });
      socket.on('close', () => {
        clearTimeout(timer);
        if (!settled) fail(new Error('Connection closed'));
        else if (current()) this._drop(new Error('Connection closed by peer'));
      });
    });
  }

  _onData(chunk) {
    if (!this.parser) return;
    for (const frame of this.parser.push(chunk)) {
      const p = this.pending;
      if (!p) {
        this.emit('unsolicited', frame);
        continue;
      }
      if (!frame.valid) {
        this.log(`Ignored invalid frame for ${p.command}`);
        continue;
      }
      clearTimeout(p.timer);
      this.pending = null;
      p.resolve(frame.payload);
    }
  }

  _drop(err) {
    if (this.socket) {
      this.socket.removeAllListeners('data');
      this.socket.destroy();
    }
    const wasConnected = !!this.ready;
    this.socket = null;
    this.parser = null;
    this.ready = null;
    clearTimeout(this.idleTimer);
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(err);
      this.pending = null;
    }
    if (wasConnected) this.emit('disconnected', err);
  }

  _armIdle() {
    clearTimeout(this.idleTimer);
    if (!this.opts.idleClose) return;
    this.idleTimer = setTimeout(() => this._drop(new Error('Idle session closed')), this.opts.idleClose);
  }

  close() {
    this.closed = true;
    this._drop(new Error('Transport closed'));
  }

}

module.exports = { DuepiTransport, DEFAULTS };
