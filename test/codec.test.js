'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const codec = require('../lib/duepi/codec');

// Synthetic device code and cross-language vector published with motionbug/testcodestove.
const CODE = '0123456789';
const VECTOR = '\x1bAAAAAAAAAAAAAAAAAAAAALLifCC1HkBdciXX+5IoTxY=&';

test('checksum and inner frames match the documented examples', () => {
  assert.strictEqual(codec.innerFrame('D9000'), 'RD90005F');
  assert.strictEqual(codec.innerFrame('F0010'), 'RF001059');
  assert.strictEqual(codec.innerFrame('F2140'), 'RF21405F');
  assert.strictEqual(codec.plainFrame('DA000').toString('latin1'), '\x1bRDA00067&');
});

test('rejects malformed commands', () => {
  assert.throws(() => codec.innerFrame('D90'), /Invalid command/);
  assert.throws(() => codec.innerFrame('d9000'), /Invalid command/);
});

test('key derivation ignores a trailing #', () => {
  assert.deepStrictEqual(codec.deriveKey(`${CODE}#`), codec.deriveKey(CODE));
  assert.throws(() => codec.deriveKey('  '), /empty/);
});

test('encrypts the reference vector with a zero IV', () => {
  const frame = codec.encryptFrame('D9000', codec.deriveKey(CODE), Buffer.alloc(16));
  assert.strictEqual(frame.toString('latin1'), VECTOR);
});

test('decrypts its own frames and ignores bytes after NUL', () => {
  const key = codec.deriveKey(CODE);
  const frame = codec.encryptFrame('ED000', key).toString('latin1');
  assert.strictEqual(codec.decryptPayload(frame.slice(1, -1), key), 'RED0006B');

  const iv = crypto.randomBytes(16);
  const plain = Buffer.concat([Buffer.from('02010023\0', 'ascii'), crypto.randomBytes(7)]);
  const c = crypto.createCipheriv('aes-128-cbc', key, iv);
  c.setAutoPadding(false);
  const b64 = Buffer.concat([iv, c.update(plain), c.final()]).toString('base64');
  assert.strictEqual(codec.decryptPayload(b64, key), '02010023');
});

test('frame parser handles banners, split and coalesced frames, plain and encrypted', () => {
  const key = codec.deriveKey(CODE);
  const parser = new codec.FrameParser(key);
  const iv = Buffer.alloc(16, 7);
  const c = crypto.createCipheriv('aes-128-cbc', key, iv);
  c.setAutoPadding(false);
  const enc = Buffer.concat([iv, c.update(Buffer.from('00030023'.padEnd(16, '\0'), 'latin1')), c.final()]).toString('base64');
  const stream = Buffer.from(`*HELLO*\x1b00000020&\x1b${enc}&`, 'latin1');

  const first = parser.push(stream.subarray(0, 20));
  const second = parser.push(stream.subarray(20));
  const frames = [...first, ...second];
  assert.strictEqual(frames.length, 2);
  assert.deepStrictEqual(frames[0], { payload: '00000020', encrypted: false, valid: true });
  assert.strictEqual(frames[1].payload, '00030023');
  assert.strictEqual(frames[1].encrypted, true);
  assert.strictEqual(frames[1].valid, true);
});

test('frame parser flags undecipherable frames as invalid', () => {
  const parser = new codec.FrameParser(codec.deriveKey('other-code'));
  const frame = codec.encryptFrame('D9000', codec.deriveKey(CODE)).toString('latin1');
  const [f] = parser.push(Buffer.from(frame, 'latin1'));
  assert.strictEqual(f.valid, false);
});
