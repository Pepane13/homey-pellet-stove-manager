'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const crypto = require('crypto');
const codec = require('../lib/duepi/codec');
const { DuepiTransport } = require('../lib/duepi/transport');
const { DuepiClient } = require('../lib/duepi/client');
const { SimulatedStove } = require('../lib/duepi/simulator');

const CODE = 'TESTCODE42';

/** Fake Duepi cloud relay backed by the simulator. */
function fakeRelay({ silentFor = [] } = {}) {
  const key = codec.deriveKey(CODE);
  const stove = new SimulatedStove();
  const seen = { logins: [], commands: [] };
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let logged = false;
    sock.on('data', async (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!logged) {
        const hash = buf.indexOf('#');
        if (hash < 0) return;
        seen.logins.push(buf.subarray(0, hash + 1).toString());
        buf = buf.subarray(hash + 1);
        logged = true;
      }
      let end;
      while ((end = buf.indexOf('&')) >= 0) {
        const body = buf.subarray(1, end).toString('latin1');
        buf = buf.subarray(end + 1);
        const inner = codec.decryptPayload(body, key);
        const cmd = inner.slice(1, 6);
        seen.commands.push(cmd);
        if (silentFor.includes(cmd)) continue;
        const reply = await stove.request(cmd);
        const iv = crypto.randomBytes(16);
        const c = crypto.createCipheriv('aes-128-cbc', key, iv);
        c.setAutoPadding(false);
        const plain = Buffer.concat([Buffer.from(`${reply}\0`, 'latin1'), crypto.randomBytes(7)]);
        sock.write(`\x1b${Buffer.concat([iv, c.update(plain), c.final()]).toString('base64')}&`);
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen })));
}

test('cloud transport logs in once and reads a full snapshot', async () => {
  const { server, port, seen } = await fakeRelay();
  const t = new DuepiTransport({ mode: 'cloud', host: '127.0.0.1', port, code: CODE, loginDelay: 20, interCommandDelay: 0 });
  try {
    const client = new DuepiClient(t);
    const s1 = await client.snapshot();
    const s2 = await client.snapshot();
    assert.ok(['off', 'ignition', 'heating', 'cooling'].includes(s1.status.status));
    assert.strictEqual(s1.hoursTotal, 1735);
    assert.strictEqual(s1.hoursService, 12);
    assert.strictEqual(s1.ambient, null);
    assert.deepStrictEqual(s1.missing, []);
    assert.strictEqual(s2.hoursTotal, 1735);
    assert.deepStrictEqual(seen.logins, [`master:${CODE}#`]); // one session reused
    assert.ok(!seen.commands.some((c) => c.startsWith('F') || c === 'D6000'), 'no write command sent');
  } finally {
    t.close();
    server.close();
  }
});

test('a missing reply times out, drops the session and the next request reconnects', async () => {
  const { server, port, seen } = await fakeRelay({ silentFor: ['EE000'] });
  const t = new DuepiTransport({ mode: 'cloud', host: '127.0.0.1', port, code: CODE, loginDelay: 20, interCommandDelay: 0, replyTimeout: 300 });
  try {
    const client = new DuepiClient(t);
    const s = await client.snapshot();
    assert.deepStrictEqual(s.missing, ['hoursService']);
    assert.strictEqual(seen.logins.length, 1);
    assert.strictEqual(t.connected, false, 'session dropped after the timeout');
    assert.strictEqual((await client.read('status')).raw.length, 8);
    assert.strictEqual(seen.logins.length, 2, 'reconnected for the next request');
  } finally {
    t.close();
    server.close();
  }
});

test('connection failures are spaced by a back-off', async () => {
  const t = new DuepiTransport({ mode: 'cloud', host: '127.0.0.1', port: 1, code: CODE, backoffMin: 60000 });
  await assert.rejects(t.request('D9000'));
  await assert.rejects(t.request('D9000'), (err) => err.code === 'BACKOFF');
  t.close();
});

test('local mode uses plain frames', async () => {
  const stove = new SimulatedStove();
  const server = net.createServer((sock) => {
    sock.write('*HELLO*');
    let buf = '';
    sock.on('data', async (d) => {
      buf += d.toString('latin1');
      let end;
      while ((end = buf.indexOf('&')) >= 0) {
        const frame = buf.slice(0, end + 1);
        buf = buf.slice(end + 1);
        sock.write(`\x1b${await stove.request(frame.slice(2, 7))}&`);
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const t = new DuepiTransport({ mode: 'local', host: '127.0.0.1', port: server.address().port, loginDelay: 20, interCommandDelay: 0 });
  try {
    assert.strictEqual(await new DuepiClient(t).read('hoursTotal'), 1735);
  } finally {
    t.close();
    server.close();
  }
});
