'use strict';

/**
 * Duepi EVO frame codec.
 *
 * Plain serial frame:   ESC + "R" + 5-char command + 2-hex checksum + "&"
 * Cloud (module M1):    ESC + Base64(IV || AES-128-CBC(inner frame, zero padded)) + "&"
 *
 * Key derivation for the original WiFi module (interoperability notes published
 * in motionbug/testcodestove, MIT licence):
 *   key = MD5(device code without trailing "#") XOR 23FADC18A422678312C86AC29281AC01
 *
 * Replies carry an 8-character payload; encrypted replies are followed by a NUL
 * byte and undefined memory, which is ignored.
 */

const crypto = require('crypto');

const ESC = 0x1b;
const END = 0x26; // '&'
const MASK = Buffer.from('23FADC18A422678312C86AC29281AC01', 'hex');

function checksum(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += body.charCodeAt(i);
  return (sum & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

/** "D9000" -> "RD90005F" */
function innerFrame(command) {
  if (!/^[0-9A-F]{5}$/.test(command)) throw new Error(`Invalid command: ${command}`);
  const body = `R${command}`;
  return body + checksum(body);
}

function plainFrame(command) {
  return Buffer.from(`\x1b${innerFrame(command)}&`, 'ascii');
}

function deriveKey(deviceCode) {
  const code = String(deviceCode || '').trim().replace(/#+$/, '');
  if (!code) throw new Error('Device code is empty');
  const md5 = crypto.createHash('md5').update(code, 'utf8').digest();
  return Buffer.from(md5.map((b, i) => b ^ MASK[i]));
}

function encryptFrame(command, key, iv = crypto.randomBytes(16)) {
  const plain = Buffer.alloc(16);
  plain.write(innerFrame(command), 'ascii');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(false);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const b64 = Buffer.concat([iv, ct]).toString('base64');
  return Buffer.concat([Buffer.from([ESC]), Buffer.from(b64, 'ascii'), Buffer.from([END])]);
}

function decryptPayload(base64, key) {
  const raw = Buffer.from(base64, 'base64');
  if (raw.length < 32 || raw.length % 16 !== 0) throw new Error(`Bad encrypted frame length ${raw.length}`);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, raw.subarray(0, 16));
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]);
  const nul = plain.indexOf(0);
  return plain.subarray(0, nul < 0 ? plain.length : nul).toString('latin1');
}

const HEX8 = /^[0-9A-Fa-f]{8}$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Accumulates bytes from a TCP stream and yields complete frames.
 * Returns { payload, encrypted } objects; payload is the 8-character reply.
 */
class FrameParser {

  constructor(key = null) {
    this.key = key;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames = [];
    for (;;) {
      const start = this.buffer.indexOf(ESC);
      if (start < 0) {
        this.buffer = Buffer.alloc(0); // banners such as *HELLO* carry no frame
        break;
      }
      const end = this.buffer.indexOf(END, start + 1);
      if (end < 0) {
        this.buffer = this.buffer.subarray(start);
        if (this.buffer.length > 256) this.buffer = Buffer.alloc(0); // garbage guard
        break;
      }
      const body = this.buffer.subarray(start + 1, end).toString('latin1');
      this.buffer = this.buffer.subarray(end + 1);
      frames.push(this._decode(body));
    }
    return frames;
  }

  _decode(body) {
    if (HEX8.test(body)) return { payload: body.toUpperCase(), encrypted: false, valid: true };
    if (this.key && body.length >= 44 && B64.test(body)) {
      try {
        const payload = decryptPayload(body, this.key);
        return { payload, encrypted: true, valid: HEX8.test(payload) };
      } catch (err) {
        return { payload: null, encrypted: true, valid: false, error: err.message };
      }
    }
    return { payload: body, encrypted: false, valid: false };
  }

}

module.exports = {
  checksum,
  innerFrame,
  plainFrame,
  deriveKey,
  encryptFrame,
  decryptPayload,
  FrameParser,
};
