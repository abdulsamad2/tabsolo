'use strict';

// Runs the Electron end-to-end tests: `npm run test:e2e`.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electron = require('electron'); // the binary path when required from Node

// VS Code terminals set this, which would make Electron run as plain Node.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// Tests record a computer-timezone change if one is attempted, instead of changing it or restarting.
// Page clocks follow each proxy and do not need that change.
env.TABSOLO_CLOCK_LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tabsolo-clock-')), 'clock.log');
// Dev-only bypass: skips the license gate so the real main.js runs without hitting the Workers API.
env.TABSOLO_SKIP_LICENSE = '1';

function run(label, file, extraEnv = {}) {
  process.stdout.write(`\n▶ ${label}\n`);
  const result = spawnSync(electron, [path.join(__dirname, file)], { env: { ...env, ...extraEnv }, encoding: 'utf8' });
  const output = `${result.stdout}${result.stderr}`.split('\n').filter((line) => line && !/^\[\d/.test(line)).join('\n');
  process.stdout.write(`${output}\n`);
  if (result.status !== 0) {
    process.stdout.write(`✖ ${label} failed\n`);
    process.exit(1);
  }
}

run('Main flow', 'e2e.electron.js');
const profileData = fs.mkdtempSync(path.join(os.tmpdir(), 'tabsolo-profiles-'));
run('Profile sessions', 'profile-sessions.electron.js', { PROFILE_SESSIONS_PHASE: '1', PROFILE_SESSIONS_DATA: profileData });
run('Profile sessions after restart', 'profile-sessions.electron.js', { PROFILE_SESSIONS_PHASE: '2', PROFILE_SESSIONS_DATA: profileData });
run('Google Sheets import', 'sheets.electron.js');
run('Saved-card CVV matching', 'card-cvv.electron.js');
run('Address autofill', 'address-autofill.electron.js');
run('Tab load order', 'load-order.electron.js');
process.stdout.write('\n✔ All Electron tests passed\n');
