'use strict';

// Telemetry is tied to a license, so this guards that private text stays out of it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTelemetryClient, instrumentIpc, scrub } = require('../src/license/telemetry');

test('scrub removes what a user could be identified or exposed by', () => {
  for (const [input, secret] of [
    ['proxy failed: http://bob:hunter2@10.0.0.5:8080/', 'hunter2'],
    ['socks5://bob:hunter2@proxy.example.com:1080 refused', 'hunter2'],
    ['navigation to https://shop.example.com/cart?coupon=SECRET failed', 'shop.example.com'],
    ['bad proxy 45.61.30.2:8080:bob:hunter2', 'hunter2'],
    ['no account for jane.doe@example.com', 'jane.doe'],
    ['card 4242 4242 4242 4242 declined', '4242'],
    ['card 4242-4242-4242-4242 declined', '4242'],
    ['ENOENT /Users/janedoe/Library/x.json', 'janedoe'],
    ['ENOENT C:\\Users\\janedoe\\AppData\\x.json', 'janedoe'],
    ['at file:///Users/janedoe/app/main.js:1:2', 'janedoe'],
  ]) assert.ok(!scrub(input).includes(secret), `${secret} survived: ${scrub(input)}`);
  assert.equal(scrub('Cannot read properties of undefined'), 'Cannot read properties of undefined');
});

function client(isEnabled) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-'));
  const made = createTelemetryClient({ apiBase: 'http://localhost', dataDir, appVersion: '1', deviceId: 'd', getLicenseKey: () => 'k', getToken: () => 'token', isEnabled });
  return { ...made, queue: () => JSON.parse(fs.readFileSync(path.join(dataDir, 'telemetry-queue.json'), 'utf8')) };
}

test('an error is sent once per launch and is scrubbed, stack included', () => {
  const c = client();
  const err = new Error('failed for jane@example.com');
  for (let i = 0; i < 5; i++) c.trackError(err);
  const queue = c.queue();
  assert.equal(queue.length, 1);
  assert.ok(!JSON.stringify(queue).includes('jane@example.com'));
});

test('instrumentIpc reports the channel name only, and passes results and errors through', async () => {
  const handlers = {};
  const ipcMain = { handle: (channel, fn) => { handlers[channel] = fn; } };
  const c = client();
  instrumentIpc(ipcMain, () => c);
  ipcMain.handle('playbooks:run', (_e, arg) => ({ echoed: arg }));
  ipcMain.handle('profiles:save', () => ({ error: 'Name taken' }));
  ipcMain.handle('profiles:list', () => ({ error: 'ignored for a non-feature' }));
  ipcMain.handle('clipboard:decrypt', () => { throw new Error('boom'); });

  assert.deepEqual(await handlers['playbooks:run']({}, 'card 4242424242424242'), { echoed: 'card 4242424242424242' });
  await handlers['profiles:save']({});
  await handlers['profiles:list']({});
  await assert.rejects(handlers['clipboard:decrypt']({}), /boom/);

  const queue = c.queue();
  assert.deepEqual(queue.filter((q) => q.kind === 'event').map((q) => q.body.name), ['playbooks:run', 'profiles:save']);
  assert.deepEqual(queue.filter((q) => q.kind === 'error').map((q) => q.body.message), ['profiles:save: Name taken', 'boom']);
  assert.ok(!JSON.stringify(queue).includes('4242'), 'arguments must never be reported');
});

test('opting out stops new reports at once and drops queued ones unsent', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200 }));
  let enabled = true;
  const c = client(() => enabled);
  c.trackEvent('before');
  assert.equal(c.queue().length, 1);
  enabled = false;
  c.trackEvent('after');
  assert.equal(c.queue().length, 1, 'nothing new is queued after opting out');
  await c.flush();
  assert.equal(c.queue().length, 0, 'queued reports are dropped');
  assert.equal(fetchMock.mock.callCount(), 0, 'nothing is sent after opting out');
});

test('the opt-out is a saved setting', () => {
  // saveSettings and the loader drop any key missing from SETTINGS_DEFAULTS, which would silently ignore the checkbox.
  const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  assert.match(main, /const SETTINGS_DEFAULTS = \{[^}]*telemetryEnabled: true/);
});
