'use strict';

// Profile session check, run by test/run-electron-tests.js in two phases against the same data folder:
// phase 1 checks cookie isolation between profiles, phase 2 checks that a profile's cookies survive a restart.

const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const phase = process.env.PROFILE_SESSIONS_PHASE ?? '1';
const userData = process.env.PROFILE_SESSIONS_DATA ?? fs.mkdtempSync(path.join(os.tmpdir(), 'tabsolo-profiles-'));
app.setPath('userData', userData);

/** Requests the proxy served: proxy username (which session) and the visitor cookie the page sent. */
const requests = [];
const proxy = http.createServer((req, res) => {
  const auth = req.headers['proxy-authorization'];
  if (!auth) {
    res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="x"' });
    res.end();
    return;
  }
  if (req.url.endsWith('favicon.ico')) {
    res.writeHead(404);
    res.end();
    return;
  }
  const user = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':')[0];
  // The proxy-IP timezone lookup (TABSOLO_TZ_LOOKUP_URL) isn't a page visit.
  if (new URL(req.url).host === 'tz-lookup.test') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"timezone":"America/Chicago"}');
    return;
  }
  const cookie = /visitor=(\w+)/.exec(req.headers.cookie ?? '')?.[1] ?? null;
  requests.push({ user, cookie });
  res.writeHead(200, {
    'content-type': 'text/html',
    // Long-lived, so it would survive a restart if (and only if) the session is persistent.
    ...(cookie ? {} : { 'set-cookie': `visitor=${crypto.randomUUID().slice(0, 6)}; Path=/; Max-Age=86400` }),
  });
  res.end(`<title>${user}</title>`);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// The restart phase reuses phase 1's port, as a real proxy gateway keeps its address.
const portFile = path.join(userData, 'proxy-port');
const listenPort = phase === '1' ? 0 : Number(fs.readFileSync(portFile, 'utf8'));
proxy.listen(listenPort, '127.0.0.1', () => {
  fs.writeFileSync(portFile, String(proxy.address().port));
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    startURL: 'http://profile-sessions.example/',
    tabCount: 3,
    isolation: 'perTab',
    proxySource: 'rotating',
    rotating: { host: '127.0.0.1', port: proxy.address().port, usernameTemplate: 'session-{session}', password: 'pw' },
  }));
  process.env.TABSOLO_TZ_LOOKUP_URL = 'http://tz-lookup.test/json';
  process.env.TABSOLO_CLOCK_LOG ??= path.join(userData, 'clock.log');
  require('../src/main.js');
});

app.whenReady().then(async () => {
  try {
    let win;
    while (!(win = BrowserWindow.getAllWindows()[0])) await sleep(100);
    await waitFor(() => !win.webContents.isLoading() && win.webContents.getURL(), 'launcher');
    const ui = (code) => win.webContents.executeJavaScript(code);
    await ui(`document.querySelector('#launch-form button[type=submit]').click()`);
    await waitFor(() => new Set(requests.map((r) => r.user)).size >= 3, 'three tabs loaded');

    const port = proxy.address().port;
    if (phase === '1') {
      // Every account browses through a proxy from the start-screen pool pinned to it, including Charlie
      // and Delta, whose sheet proxies are kept but not used.
      const csv = [
        'Profile,Name,Email,Proxy,Proxy 2',
        'Alpha,Ann Lee,ann@example.com,,',
        'Bravo,Bob Ray,bob@example.com,,',
        `Charlie,Cara Diaz,cara@example.com,127.0.0.1:${port}:charlie-main:secret-main,127.0.0.1:${port}:charlie-backup:secret-backup`,
        `Delta,Dan Ito,dan@example.com,127.0.0.1:${port}:delta-only:secret-delta,`,
      ].join('\\n');
      await ui(`window.fleet.importProfilesText('${csv}')`);
    }
    const profiles = await ui('window.fleet.listProfiles()');
    const id = (name) => profiles.find((p) => p.profile === name).id;
    const tabIds = await ui(`[...document.querySelectorAll('.tab')].map((el) => el.dataset.id)`);
    const send = (name, tabId, arg) => ui(`window.fleet.command(${JSON.stringify(name)}, ${JSON.stringify(tabId)}, ${JSON.stringify(arg)})`);
    const proxyUser = (tabId) => ui(`document.querySelector('.tab[data-id="${tabId}"]').title.split('\\n').find((l) => l.startsWith('Proxy:'))?.split(' · ').pop()`);

    /** Runs an action on one tab (the others are idle) and returns the cookie its next page request sent. */
    async function nextCookie(tabId, action) {
      const count = requests.length;
      await action();
      return (await waitFor(() => requests[count], `request after action on tab ${tabId}`)).cookie;
    }
    const reload = (tabId) => nextCookie(tabId, () => send('reload', tabId));
    const assign = (tabId, profile) => nextCookie(tabId, () => send('setProfile', tabId, profile && id(profile)));

    const results = {};
    if (phase === '1') {
      // Tab 1 = Alpha, tab 2 = Bravo, tab 3 = Alpha. First visit in each profile session sets its cookie.
      await assign(tabIds[0], 'Alpha');
      await assign(tabIds[1], 'Bravo');
      const alpha = await reload(tabIds[0]);
      const bravo = await reload(tabIds[1]);
      assert.ok(alpha && bravo && alpha !== bravo, 'Alpha and Bravo have different cookies');

      results.alphaTabsShareCookies = await assign(tabIds[2], 'Alpha');
      assert.equal(results.alphaTabsShareCookies, alpha, 'a second Alpha tab sees Alpha\'s cookie');

      results.switchedToBravo = await assign(tabIds[0], 'Bravo');
      assert.equal(results.switchedToBravo, bravo, 'switching a tab to Bravo gives it Bravo\'s cookie, not Alpha\'s');

      results.profileRemoved = await assign(tabIds[0], null);
      assert.equal(results.profileRemoved, null, 'removing the profile gives the tab a fresh session');

      const beforeBurn = await proxyUser(tabIds[2]);
      results.burnKeepsLogin = await nextCookie(tabIds[2], () => send('burn', tabIds[2]));
      assert.notEqual(await proxyUser(tabIds[2]), beforeBurn, 'burn moves the profile to a new IP');
      assert.equal(results.burnKeepsLogin, alpha, 'burn keeps the profile\'s cookies');

      // Clearing reloads the profile's tabs; that reload must arrive without the old cookie.
      results.clearedBravo = await nextCookie(tabIds[1], () => send('clearProfileCookies', tabIds[1]));
      assert.equal(results.clearedBravo, null, 'Clear profile cookies logs the profile out');
      const bravoAgain = await reload(tabIds[1]);

      // Sheet proxies aren't used: accounts get pinned pool proxies, and New IP gives a fresh one.
      assert.ok(!JSON.stringify(await ui('window.fleet.listProfiles()')).includes('secret-'), 'no proxy password reaches the window');
      await assign(tabIds[0], 'Charlie');
      const charlieFirst = await proxyUser(tabIds[0]);
      assert.match(charlieFirst, /^session-/, "an account with a sheet proxy still browses through the pool");
      await nextCookie(tabIds[0], () => send('burn', tabIds[0]));
      const charliePin = await proxyUser(tabIds[0]);
      assert.ok(/^session-/.test(charliePin) && charliePin !== charlieFirst, 'New IP gives the account a fresh pool proxy');
      await assign(tabIds[1], 'Delta');
      const deltaFirst = await proxyUser(tabIds[1]);
      await nextCookie(tabIds[1], () => send('burn', tabIds[1]));
      assert.ok(/^session-/.test(deltaFirst) && (await proxyUser(tabIds[1])) !== deltaFirst, 'a single sheet proxy no longer blocks New IP');
      assert.ok(!requests.some((r) => /charlie-|delta-only/.test(r.user)), 'sheet proxies are never used');
      const alphaPin = await proxyUser(tabIds[2]); // Alpha, after New IP above
      await assign(tabIds[1], 'Bravo');
      const bravoPin = await proxyUser(tabIds[1]);
      assert.notEqual(alphaPin, bravoPin, 'accounts get different pinned IPs');

      fs.writeFileSync(path.join(userData, 'expected.json'), JSON.stringify({ alpha, bravo: bravoAgain, alphaPin, bravoPin, charliePin }));
      await sleep(500); // let the last profile save finish before quitting
      console.log(JSON.stringify({ phase, ok: true, alpha, bravo, ...results }, null, 2));
      app.exit(0);
    } else {
      const expected = JSON.parse(fs.readFileSync(path.join(userData, 'expected.json'), 'utf8'));
      results.alphaAfterRestart = await assign(tabIds[0], 'Alpha');
      results.bravoAfterRestart = await assign(tabIds[1], 'Bravo');
      assert.equal(results.alphaAfterRestart, expected.alpha, 'Alpha is still logged in after a restart');
      assert.equal(results.bravoAfterRestart, expected.bravo, 'Bravo is still logged in after a restart');
      assert.equal(await proxyUser(tabIds[0]), expected.alphaPin, 'Alpha keeps its pinned IP after a restart');
      assert.equal(await proxyUser(tabIds[1]), expected.bravoPin, 'Bravo keeps its pinned IP after a restart');
      await assign(tabIds[2], 'Charlie');
      assert.equal(await proxyUser(tabIds[2]), expected.charliePin, 'Charlie keeps the pool proxy it was moved to');
      console.log(JSON.stringify({ phase, ok: true, ...results }, null, 2));
      app.exit(0);
    }
  } catch (error) {
    console.error(JSON.stringify({ phase, ok: false, error: error.message, requests: requests.slice(-6) }, null, 2));
    app.exit(1);
  }
});
