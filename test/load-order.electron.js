'use strict';

// Load scheduling: the selected tab loads first and alone; background tabs then load a few at a time;
// selecting a tab that's still waiting loads it straight away.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tabsolo-load-'));
app.setPath('userData', userData);
const TABS = 10;
const requests = []; // { start, end, tab }
let active = 0;
let maxActive = 0;
const server = http.createServer((req, res) => {
  const entry = { start: Date.now(), end: null, tab: new URL(req.url, 'http://x').searchParams.get('t') };
  requests.push(entry);
  maxActive = Math.max(maxActive, ++active);
  setTimeout(() => {
    entry.end = Date.now();
    active--;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>loaded</title>ok');
  }, 400);
});

server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    startURL: `http://127.0.0.1:${server.address().port}/`, tabCount: TABS, isolation: 'perTab', proxySource: 'none',
  }));
  process.env.SEATSCOUTS_COMPANY_ID = '';
  process.env.SEATSCOUTS_API_TOKEN = '';
  require('../src/main.js');
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

app.whenReady().then(async () => {
  try {
    const win = await waitFor(() => BrowserWindow.getAllWindows()[0], 'window');
    await waitFor(() => !win.webContents.isLoading() && win.webContents.getURL(), 'launcher');
    const ui = (code) => win.webContents.executeJavaScript(code);
    await sleep(200);
    await ui(`document.querySelector('#launch-form button[type=submit]').click()`);
    await waitFor(() => requests.length >= 1, 'first request');
    await sleep(250);
    assert.equal(requests.length, 1, 'only the selected tab loads while it is loading');
    await waitFor(() => requests.length >= 2, 'background tabs start');
    assert.ok(requests[1].start >= requests[0].end, 'background tabs wait for the selected tab');

    // Jump the queue: select the last tab while it's still waiting.
    const waiting = await waitFor(() => ui(`(() => {
      const tabs = [...document.querySelectorAll('.tab')];
      const last = tabs.at(-1);
      return last && last.querySelector('.title').textContent === 'Waiting to load…' && last.dataset.id;
    })()`), 'a waiting tab');
    const before = requests.length;
    await ui(`window.fleet.command('selectTab', ${JSON.stringify(waiting)})`);
    await waitFor(() => requests.length > before, 'selected waiting tab loads');

    await waitFor(() => requests.length === TABS && requests.every((r) => r.end), 'every tab loads');
    assert.ok(maxActive <= 5, `at most the selected tab + 4 background loads at once (saw ${maxActive})`);
    const titles = await waitFor(async () => {
      const t = await ui(`[...document.querySelectorAll('.tab .title')].map((el) => el.textContent)`);
      return t.every((title) => title === 'loaded') && t;
    }, 'all tabs show their page');
    console.log(JSON.stringify({ ok: true, tabs: titles.length, maxConcurrent: maxActive }));
    app.exit(0);
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message, requests: requests.length, maxActive }));
    app.exit(1);
  }
});
