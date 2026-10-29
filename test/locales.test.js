'use strict';

// Homey's this.homey.__(key, tokens) only replaces __name__ placeholders: {{name}} or {name}
// would reach the user as raw text. The settings page uses its own helper, so only the
// strings rendered by the app itself (everything outside "settings") are checked here.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const LOCALES = ['en', 'fr'];
const load = (lang) => require(path.join(__dirname, '..', 'locales', `${lang}.json`));

// Same behaviour as the Homey SDK: look up a dotted key, then replace __token__.
function homeyTranslate(locale, key, tokens = {}) {
  let s = key.split('.').reduce((o, k) => (o == null ? o : o[k]), locale);
  assert.strictEqual(typeof s, 'string', `missing key ${key}`);
  for (const [k, v] of Object.entries(tokens)) s = s.split(`__${k}__`).join(String(v));
  return s;
}

function strings(obj, prefix = '') {
  return Object.entries(obj).flatMap(([k, v]) => (typeof v === 'string'
    ? [[prefix + k, v]] : strings(v, `${prefix}${k}.`)));
}

const UNRESOLVED = /\{\{?\s*\w+\s*\}?\}|__\w+__/;

for (const lang of LOCALES) {
  test(`${lang}: app-side strings only use the __token__ syntax`, () => {
    const bad = strings(load(lang))
      .filter(([k]) => !k.startsWith('settings.'))
      .filter(([, v]) => /\{\{?\s*\w+\s*\}?\}/.test(v));
    assert.deepStrictEqual(bad, []);
  });

  test(`${lang}: start time messages are fully rendered`, () => {
    const l = load(lang);
    const cases = [
      ['plan.not_needed', { target: 21 }],
      ['plan.start_at', { time: '05:40', target: 21 }],
      ['plan.unreachable', { target: 21, expected: 19.5 }],
      ['pair.success', { status: 'Off', hours: 1234 }],
      ['pair.error_connect', { error: 'timeout' }],
    ];
    for (const [key, tokens] of cases) {
      const out = homeyTranslate(l, key, tokens);
      assert.doesNotMatch(out, UNRESOLVED, `${key}: ${out}`);
      for (const v of Object.values(tokens)) assert.ok(out.includes(String(v)), `${key} lacks ${v}: ${out}`);
    }
  });
}

test('en and fr have the same keys', () => {
  const keys = (lang) => strings(load(lang)).map(([k]) => k).sort();
  assert.deepStrictEqual(keys('fr'), keys('en'));
});
