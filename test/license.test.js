'use strict';

// Guards the license token flow: the server signs tokens with Ed25519 and the app checks them with
// the public key, so the free beta can be ended and a token can't be edited to outlive it.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLicenseClient, readToken } = require('../src/license/license');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

function sign(payload, key = privateKey) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${crypto.sign(null, Buffer.from(body), key).toString('base64url')}`;
}

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabsolo-license-'));
  const client = createLicenseClient({ dataDir, appVersion: 'test', publicKey });
  const file = path.join(dataDir, 'license.json');
  const save = (token) => fs.writeFileSync(file, JSON.stringify({ token, licenseKey: 'K', plan: 'beta' }));
  return { client, file, save };
}
const hour = 3_600_000;
const claimsFor = (client, extra = {}) => ({ k: 'K', d: client.deviceId, p: 'beta', iat: Date.now(), exp: Date.now() + hour, ...extra });
const networkDown = (t) => t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
const serverSays = (t, status, body) => t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(body), { status }));

test('only a token signed by our key can be read', () => {
  const token = sign({ k: 'K', d: 'dev1', iat: 1, exp: 2 });
  assert.equal(readToken(token, publicKey).k, 'K');
  const [body, sig] = token.split('.');
  const edited = Buffer.from(JSON.stringify({ k: 'K', d: 'dev1', iat: 1, exp: 9e15 })).toString('base64url');
  assert.equal(readToken(`${edited}.${sig}`, publicKey), null, 'edited expiry');
  assert.equal(readToken(`${body}.${sig.slice(0, -2)}AA`, publicKey), null, 'edited signature');
  assert.equal(readToken(sign({ exp: 2 }, crypto.generateKeyPairSync('ed25519').privateKey), publicKey), null, 'another key');
  assert.equal(readToken(sign({ k: 'no exp' }), publicKey), null);
  assert.equal(readToken('nope', publicKey), null);
  assert.equal(readToken('', publicKey), null);
});

test('offline, a valid token works until it expires and an edited one never does', async (t) => {
  networkDown(t);
  const { client, save } = setup();
  save(sign(claimsFor(client)));
  assert.equal((await client.validateAtStartup()).source, 'cache');

  save(sign(claimsFor(client, { iat: Date.now() - 2 * hour, exp: Date.now() - hour })));
  assert.deepEqual(await client.validateAtStartup(), { ok: false, reason: 'expired_offline' });

  save(sign(claimsFor(client, { iat: Date.now() + 2 * 86_400_000, exp: Date.now() + 3 * 86_400_000 })));
  assert.deepEqual(await client.validateAtStartup(), { ok: false, reason: 'expired_offline' }, 'clock set back before the token');

  const [, sig] = sign(claimsFor(client)).split('.');
  const edited = Buffer.from(JSON.stringify(claimsFor(client, { exp: Date.now() + 1e12 }))).toString('base64url');
  save(`${edited}.${sig}`);
  assert.deepEqual(await client.validateAtStartup(), { ok: false, reason: 'invalid_token' });
});

test('when the plan has ended the server refusal removes the license', async (t) => {
  serverSays(t, 403, { ok: false, error: 'plan_ended' });
  const { client, file, save } = setup();
  save(sign(claimsFor(client)));
  assert.deepEqual(await client.validateAtStartup(), { ok: false, reason: 'plan_ended' });
  assert.equal(fs.existsSync(file), false);
});

test('a fake server cannot approve a license', async (t) => {
  const { client, file, save } = setup();
  const forged = sign(claimsFor(client, { exp: Date.now() + 1e12 }), crypto.generateKeyPairSync('ed25519').privateKey);
  serverSays(t, 200, { ok: true, token: forged, plan: 'pro' });
  assert.equal((await client.activate('K')).ok, false);
  assert.equal(fs.existsSync(file), false);

  const real = sign(claimsFor(client));
  save(real);
  await client.validateAtStartup();
  assert.equal(JSON.parse(fs.readFileSync(file)).token, real, 'the forged token was not saved');
});

test('a license file copied from another computer is refused without using it', async (t) => {
  const calls = [];
  const { client, file, save } = setup();
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, token: sign(claimsFor(client)), plan: 'beta' }), { status: 200 });
  });
  save(sign(claimsFor(client)));
  assert.equal((await client.validateAtStartup()).ok, true);
  assert.equal(calls[0].deviceId, client.deviceId, 'the server is told which computer is asking');

  save(sign(claimsFor(client, { d: 'another-computer' })));
  assert.deepEqual(await client.validateAtStartup(), { ok: false, reason: 'device_mismatch' });
  assert.equal(calls.length, 1, 'no server call for a copied file');
  assert.equal(fs.existsSync(file), false, 'the copied file is removed');
});

test('deactivating frees the slot and keeps the license if the server can not be reached', async (t) => {
  const { client, file, save } = setup();
  save(sign(claimsFor(client)));
  const down = networkDown(t);
  assert.equal((await client.deactivate()).ok, false);
  assert.equal(fs.existsSync(file), true, 'still licensed: the slot was not freed');
  down.mock.restore();
  serverSays(t, 200, { ok: true });
  assert.deepEqual(await client.deactivate(), { ok: true });
  assert.equal(fs.existsSync(file), false);
  assert.equal((await client.deactivate()).error, 'no_license');
});

test('subscribing opens the checkout and activates the key once the payment lands', async (t) => {
  const { client, file } = setup();
  const opened = [];
  let activations = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    const reply = (status, body) => new Response(JSON.stringify(body), { status });
    if (url.endsWith('/api/billing/checkout')) return reply(200, { ok: true, url: 'https://polar.example/checkout', key: 'TS-AAAA-BBBB-CCCC' });
    activations += 1;
    if (activations === 1) throw new Error('offline');
    if (activations === 2) return reply(404, { ok: false, error: 'invalid_key' });
    return reply(200, { ok: true, token: sign(claimsFor(client)), plan: 'solo' });
  });
  const result = await client.subscribe(async (url) => opened.push(url), { pollMs: 1 });
  assert.deepEqual([result.ok, result.plan, activations], [true, 'solo', 3], 'waits through a network blip and the unpaid key');
  assert.deepEqual(opened, ['https://polar.example/checkout']);
  assert.equal(JSON.parse(fs.readFileSync(file)).licenseKey, 'TS-AAAA-BBBB-CCCC');
});

test('subscribing never opens anything but a web page, and stops when the server refuses the key', async (t) => {
  const { client } = setup();
  const opened = [];
  const fetched = serverSays(t, 200, { ok: true, url: 'file:///Applications/Calculator.app', key: 'K' });
  assert.equal((await client.subscribe(async (url) => opened.push(url), { pollMs: 1 })).ok, false);
  assert.deepEqual(opened, []);
  fetched.mock.restore();

  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => (calls++ === 0
    ? new Response(JSON.stringify({ ok: true, url: 'https://polar.example/checkout', key: 'K' }))
    : new Response(JSON.stringify({ ok: false, error: 'expired' }), { status: 403 })));
  assert.equal((await client.subscribe(async () => {}, { pollMs: 1 })).error, 'expired');
  assert.equal(calls, 2, 'no more polling after a final answer');
  calls = 0;
  assert.equal((await client.subscribe(async () => {}, { pollMs: 1, tries: 0 })).error, 'checkout_timeout');
});

test('the computer id ignores the network adapter when a hardware id exists', () => {
  const { fingerprint } = require('../src/license/device');
  assert.equal(fingerprint('darwin', 'arm64', 'UUID', 'aa:aa'), fingerprint('darwin', 'arm64', 'UUID', 'bb:bb'));
  assert.notEqual(fingerprint('darwin', 'arm64', 'UUID-1', 'aa'), fingerprint('darwin', 'arm64', 'UUID-2', 'aa'));
  assert.notEqual(fingerprint('linux', 'x64', null, 'aa:aa'), fingerprint('linux', 'x64', null, 'bb:bb'));
});

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
