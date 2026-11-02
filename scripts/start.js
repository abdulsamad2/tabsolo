'use strict';

// `npm start`: runs TabSolo attached to this terminal. If TabSolo asks to be started again (exit code
// 75 and a restart file), this script does it, so the app stays attached here instead of the terminal
// returning while a detached copy runs.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electron = require('electron');

const RESTART = 75; // exit code: "start me again with the timezone in the restart file"
const restartFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tabsolo-start-')), 'restart.json');
const env = { ...process.env, TABSOLO_RESTART_FILE: restartFile };
delete env.ELECTRON_RUN_AS_NODE;

function start() {
  const child = spawn(electron, [path.join(__dirname, '..'), ...process.argv.slice(2)], { stdio: 'inherit', env });
  child.on('exit', (code, signal) => {
    if (code === RESTART && fs.existsSync(restartFile)) {
      const { tz } = JSON.parse(fs.readFileSync(restartFile, 'utf8'));
      fs.rmSync(restartFile);
      if (tz) env.TZ = tz;
      else delete env.TZ;
      console.log(`TabSolo: restarting with the clock in ${tz || "this computer's timezone"}…`);
      return start();
    }
    process.exit(signal ? 1 : code ?? 0);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {});
start();
