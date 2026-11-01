'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { windowsAuthSwitches } = require('../src/platform-session');

test('windowsAuthSwitches pins Chromium to a nothing allowlist on Windows and is empty elsewhere', () => {
  assert.deepEqual(windowsAuthSwitches('win32'), [
    ['auth-server-allowlist', '*.tabsolo.invalid'],
    ['auth-negotiate-delegate-allowlist', '*.tabsolo.invalid'],
  ]);
  assert.deepEqual(windowsAuthSwitches('darwin'), []);
  assert.deepEqual(windowsAuthSwitches('linux'), []);
});
