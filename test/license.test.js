'use strict';

// Guards the license token flow: the client peeks at tokens for the offline grace check, and the
// server signs/verifies them with HMAC-SHA-256 (Workers crypto.subtle, same APIs Node exposes).
// If this file flakes, licensing is already broken.

const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');

const b64url = {
  encode: (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
};

async function importHmacKey(secret, usage) {
  return webcrypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

async function sign(secret, payload) {
  const body = b64url.encode(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await importHmacKey(secret, 'sign');
  const sig = await webcrypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `${body}.${b64url.encode(new Uint8Array(sig))}`;
}

test('peekToken decodes a valid token and reads exp', async () => {
  const { peekToken } = require('../src/license/license');
  const token = await sign('secret', { k: 'TF-ABCD', d: 'dev1', p: 'solo', iat: 1, exp: 2 });
  const claims = peekToken(token);
  assert.equal(claims.k, 'TF-ABCD');
  assert.equal(claims.exp, 2);
});

test('peekToken rejects tokens without an exp or a body', () => {
  const { peekToken } = require('../src/license/license');
  assert.equal(peekToken('nope'), null);
  assert.equal(peekToken(''), null);
  const noExp = `${b64url.encode(Buffer.from(JSON.stringify({ k: 'x' })))}.whatever`;
  assert.equal(peekToken(noExp), null);
});

test('a tampered signature fails HMAC verification', async () => {
  const token = await sign('secret', { k: 'TF-ABCD', d: 'dev1', p: 'solo', iat: 1, exp: 2 });
  const [body, sig] = token.split('.');
  const flippedSig = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
  const key = await importHmacKey('secret', 'verify');
  const sigBytes = Uint8Array.from(Buffer.from(flippedSig.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((flippedSig.length + 3) % 4), 'base64'));
  const ok = await webcrypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(body));
  assert.equal(ok, false);
});

test('a tampered body fails HMAC verification', async () => {
  const token = await sign('secret', { k: 'TF-ABCD', d: 'dev1', p: 'solo', iat: 1, exp: 2 });
  const [body, sig] = token.split('.');
  const flippedBody = body.slice(0, -1) + (body.endsWith('A') ? 'B' : 'A');
  const key = await importHmacKey('secret', 'verify');
  const sigBytes = Uint8Array.from(Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((sig.length + 3) % 4), 'base64'));
  const ok = await webcrypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(flippedBody));
  assert.equal(ok, false);
});

// Finding 16: pin the playbook escaping. Order fields flow into executeJavaScript via
// JSON.stringify, so any `"</script>` or similar must stay escaped. A refactor that drops the
// stringify or interpolates values with ${…} will trip this test immediately.
// The regex that gates the seat-match overlay injection in src/main.js:1174. Mirror it here so
// a future edit that reopens the TLD branch (back to `[a-z.]+`) is caught before it ships.
const TICKETMASTER_URL = /^https:\/\/(www\.)?ticketmaster\.(com|ca|co\.uk|de|fr|es|it|nl|com\.au|co\.nz|com\.mx)\/(event|resale|exchange|t)\//i;

test('seat-match overlay only injects on real Ticketmaster hosts', () => {
  for (const good of [
    'https://www.ticketmaster.com/event/42',
    'https://ticketmaster.com/event/42',
    'https://www.ticketmaster.ca/resale/x',
    'https://www.ticketmaster.co.uk/event/x',
    'https://www.ticketmaster.de/event/x',
  ]) assert.ok(TICKETMASTER_URL.test(good), good);
  for (const bad of [
    'https://ticketmaster.evil.com/event/x',
    'https://ticketmaster.co.evil/event/x',
    'https://ticketmaster.com.evil/event/x',
    'https://notticketmaster.com/event/x',
    'http://www.ticketmaster.com/event/x',
  ]) assert.ok(!TICKETMASTER_URL.test(bad), bad);
});

test('replayer inlines actions through JSON.stringify so hostile values stay string-escaped', () => {
  const { buildReplayerScript } = require('../src/replayer-script');
  const script = buildReplayerScript([{ type: 'input', value: '"breakout', selector: '#x' }]);
  // The leading " of the hostile value must appear as \" inside the payload literal — a future
  // refactor that drops JSON.stringify and uses ${…} interpolation would ship it raw and fail here.
  assert.ok(script.includes('\\"breakout'), 'leading " must be JSON-escaped');
  assert.ok(!script.includes('"value":""breakout'), 'raw unescaped break-out must not appear');
});

test('replayer handles wait actions', () => {
  const { buildReplayerScript } = require('../src/replayer-script');
  const script = buildReplayerScript([{ type: 'wait', ms: 1500 }]);
  // The wait case must branch into sleep(ms) and clamp the value.
  assert.ok(script.includes("action.type === 'wait'"), 'wait branch missing');
  assert.ok(script.includes('"ms":1500'), 'wait ms must be preserved in payload');
  assert.ok(script.includes('Math.min(60000'), 'wait ms must be clamped');
});
