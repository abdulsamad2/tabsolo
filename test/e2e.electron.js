'use strict';

// End-to-end check: run with `npx electron test/e2e.electron.js` (unset ELECTRON_RUN_AS_NODE first).
// Launches TabSolo against a local authenticating proxy, drives the real UI, and checks per-tab
// sessions, Burn IP (new IP + fresh cookies), regions, Switch To Proxy, colors, notes, timers, quick fill and profiles.

const { app, BrowserWindow, webContents, dialog, session } = require('electron');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tabsolo-e2e-'));
const outDir = process.env.E2E_OUT ?? userData;
app.setPath('userData', userData);

/** Every authenticated request the proxy served: which session username, and which visitor cookie it carried. */
const requests = [];
const proxy = http.createServer((req, res) => {
  const auth = req.headers['proxy-authorization'];
  if (!auth) {
    res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="e2e"' });
    res.end();
    return;
  }
  const [user, password] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  if (password !== 'pw') {
    res.writeHead(403);
    res.end();
    return;
  }
  // The proxy-IP timezone lookup (TABSOLO_TZ_LOOKUP_URL): where each proxy "is".
  if (new URL(req.url).host === 'tz-lookup.test') {
    tzLookups.push(user);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ timezone: 'America/Chicago' }));
    return;
  }
  if (req.url.endsWith('/favicon.ico')) {
    res.writeHead(404);
    res.end();
    return;
  }
  const cookie = /visitor=(\w+)/.exec(req.headers.cookie ?? '')?.[1] ?? null;
  requests.push({ user, cookie, path: new URL(req.url).pathname, language: req.headers['accept-language'], ua: req.headers['user-agent'] });
  res.writeHead(200, {
    'content-type': 'text/html',
    ...(cookie ? {} : { 'set-cookie': `visitor=${crypto.randomUUID().slice(0, 8)}; Path=/` }),
  });
  const page = req.url.endsWith('/checkout') ? CHECKOUT_FORM : req.url.endsWith('/login') ? LOGIN_FORM : req.url.endsWith('/signin') ? SIGNIN_FORM : null;
  res.end(page ? page.replace('{user}', user) : `<title>${user}</title><input id="field" autofocus><script>window.firstZone = Intl.DateTimeFormat().resolvedOptions().timeZone</script>`);
});

const users = () => new Set(requests.map((r) => r.user));
const tzLookups = [];

// A stand-in for Automatiq Sync's Get Orders API: checks the auth headers, filters and pages.
const syncRequests = [];
const SYNC_ORDERS = Array.from({ length: 120 }, (_, i) => ({
  id: 9000 + i, order_id: String(700000000 + i), marketplace: i % 3 ? 'viagogo' : 'vividseats',
  status: i < 3 ? 'invoiced' : i % 10 === 0 ? 'rejected' : 'delivered', event_name: i % 2 ? 'Lakers vs Celtics' : 'Taylor Swift',
  venue_name: 'Crypto.com Arena', occurs_at: '2026-12-01T19:30:00', order_date: '2026-10-20T08:15:00',
  section: '112', row: 'F', low_seat: '5', high_seat: '6', quantity: 2, unit_price: '120.5', total: '241.00',
  delivery: 'mobile', in_hand: '2026-11-30', error_reason: null, auto_fulfill: true,
}));
const syncServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://sync.test');
  syncRequests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), company: req.headers['x-company-id'], token: req.headers['x-api-token'] });
  res.setHeader('content-type', 'application/json');
  if (req.headers['x-company-id'] !== '4242' || req.headers['x-api-token'] !== 'sync-test-token') {
    res.writeHead(401);
    return res.end('{"error":"Unauthorized"}');
  }
  let rows = SYNC_ORDERS;
  if (url.searchParams.get('status')) rows = rows.filter((o) => url.searchParams.get('status').split(',').includes(o.status));
  if (url.searchParams.get('event_name')) rows = rows.filter((o) => o.event_name.toLowerCase().includes(url.searchParams.get('event_name').toLowerCase()));
  const limit = Number(url.searchParams.get('limit'));
  const page = Number(url.searchParams.get('page'));
  res.end(JSON.stringify({ count: rows.length, page, data: rows.slice((page - 1) * limit, page * limit) }));
});
let proxyPort = 0;

// A checkout-style form mixing autocomplete tokens, names, ids and labels, as real sites do.
// A login form next to a sign-up form: only the login form may get the saved password.
const LOGIN_FORM = `<title>{user}</title>
  <form id="login"><input name="login" type="text"><input name="pass" type="password" autocomplete="current-password"></form>
  <form id="signup"><input name="newpass" type="password" autocomplete="new-password"></form>`;

// Records presses of its Continue button.
const SIGNIN_FORM = `<title>{user}</title><div style="height:1500px"></div>
  <form onsubmit="event.preventDefault()"><input name="email" type="email"><button type="submit" style="width:200px;height:40px">Continue</button></form>
  <script>
    window.clicks = []; window.moves = 0;
    addEventListener('mousemove', (e) => { if (e.isTrusted) window.moves++; });
    document.querySelector('button').addEventListener('click', (e) => clicks.push({ trusted: e.isTrusted, x: e.clientX, y: e.clientY }));
  </script>`;

const CHECKOUT_FORM = `<title>{user}</title><form>
  <input type="email" name="email">
  <input name="firstName"><label for="ln">Last name</label><input id="ln">
  <input autocomplete="tel">
  <input autocomplete="address-line1"><input name="city">
  <select name="state"><option value="">State</option><option>NY</option><option value="VA">Virginia</option></select>
  <input name="zip">
  <input autocomplete="cc-number">
  <select autocomplete="cc-exp-month"><option value="">MM</option>${[...Array(12)].map((_, i) => `<option>${String(i + 1).padStart(2, '0')}</option>`).join('')}</select>
  <select autocomplete="cc-exp-year"><option value="">YYYY</option><option>2027</option><option>2028</option></select>
  <input name="cvv">
  <button type="submit">Buy</button>
</form>`;

async function waitFor(check, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

proxy.listen(0, '127.0.0.1', async () => {
  const { port } = proxy.address();
  proxyPort = port;
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    startURL: 'http://fleet-e2e.example/',
    tabCount: 2,
    isolation: 'perTab',
    proxySource: 'rotating',
    rotating: { host: '127.0.0.1', port, usernameTemplate: 'u-{country}-{session}', password: 'pw', regions: 'us, ca' },
  }));
  await new Promise((resolve) => syncServer.listen(0, '127.0.0.1', resolve));
  process.env.TABSOLO_SYNC_URL = `http://127.0.0.1:${syncServer.address().port}`;
  process.env.TABSOLO_TZ_LOOKUP_URL = 'http://tz-lookup.test/json';
  process.env.TABSOLO_CLOCK_LOG = path.join(userData, 'clock.log');
  // Blank (but set) so a developer's .env.local credentials aren't loaded into this run.
  process.env.SEATSCOUTS_COMPANY_ID = '';
  process.env.SEATSCOUTS_API_TOKEN = '';
  require('../src/main.js');
});

app.whenReady().then(async () => {
  const results = {};
  try {
    const win = await waitFor(() => BrowserWindow.getAllWindows()[0], 'window');
    await waitFor(() => !win.webContents.isLoading() && win.webContents.getURL(), 'launcher');
    const ui = (code) => win.webContents.executeJavaScript(code);
    const state = () => ui(`(${() => ({
      tabs: [...document.querySelectorAll('.tab')].map((el) => ({
        title: el.querySelector('.title').textContent,
        color: el.style.getPropertyValue('--tab-color'),
        timer: el.querySelector('.timer').textContent,
        timerDone: el.classList.contains('timer-done'),
        hasNote: !el.querySelector('.note-dot').hidden,
      })),
      toggle: document.querySelector('#proxy-toggle').textContent,
      region: document.querySelector('#region').value,
    })})()`);
    const run = (name, arg) => ui(`window.fleet.command(${JSON.stringify(name)}, undefined, ${JSON.stringify(arg)})`);

    await waitFor(() => ui(`document.querySelector('[name="rotating.host"]').value === '127.0.0.1'`), 'saved config in form');
    // Settings is reachable from the start screen too.
    await ui(`document.querySelector('#launcher-settings').click()`);
    await waitFor(() => ui(`!document.querySelector('#settings-sheet').hidden`), 'settings from the launcher');
    await ui(`document.querySelector('#settings-close').click()`);
    await ui(`document.querySelector('#launch-form button[type=submit]').click()`);

    // Multiple sessions: each tab authenticates with its own US session.
    await waitFor(() => users().size >= 2, 'two tab sessions');
    assert.ok([...users()].every((u) => u.startsWith('u-us-')), 'tabs start in the first region');
    results.sessions = [...users()];

    // Burn IP: the reload carries the old cookie; the burn arrives on a new session with no cookie.
    const firstUser = await waitFor(async () => {
      const { title } = (await state()).tabs[0];
      return title.startsWith('u-') && title;
    }, 'first tab title');
    await run('reload');
    const withCookie = await waitFor(() => requests.find((r) => r.user === firstUser && r.cookie), 'reload with cookie');
    await ui(`document.querySelector('[data-cmd="burn"]').click()`);
    const burned = await waitFor(() => requests.find((r) => !results.sessions.includes(r.user)), 'burned request');
    assert.equal(burned.cookie, null, 'burned tab starts with fresh cookies');
    results.burn = { before: withCookie, after: burned };

    // Regions: switching the tab to CA reloads through a CA session.
    await ui(`(() => { const s = document.querySelector('#region'); s.value = 'ca'; s.dispatchEvent(new Event('change')); })()`);
    results.region = (await waitFor(() => requests.find((r) => r.user.startsWith('u-ca-')), 'CA request')).user;
    await waitFor(async () => (await state()).region === 'ca', 'region select shows CA');

    // Switch To Proxy: off to the local IP and back, without reloading.
    const before = requests.length;
    await ui(`document.querySelector('#proxy-toggle').click()`);
    await waitFor(async () => (await state()).toggle.includes('Local IP'), 'toggle to local IP');
    await ui(`document.querySelector('#proxy-toggle').click()`);
    results.toggle = await waitFor(async () => {
      const { toggle } = await state();
      return toggle.includes('CA · 127.0.0.1') && toggle;
    }, 'toggle back to a CA proxy');
    assert.equal(requests.length, before, 'switching proxy does not reload the page');

    // Colors, notes, timers via the Tools panel.
    await ui(`document.querySelector('#panel-toggle').click()`);
    await ui(`document.querySelectorAll('#swatches .swatch')[5].click()`);
    await ui(`(() => { const n = document.querySelector('#note'); n.value = 'Section 104 row F'; n.dispatchEvent(new Event('input')); })()`);
    await run('setTimer', 0.02);
    const tabState = await waitFor(async () => {
      const tab = (await state()).tabs[0];
      return tab.color && tab.hasNote && tab.timerDone && tab;
    }, 'color, note and finished timer on tab 1').catch(async (error) => { console.error(JSON.stringify(await state()), JSON.stringify(requests.slice(-3))); throw error; });
    results.tab = tabState;

    // Quick fill: snippets round-trip encrypted, and Insert types into the page's focused field.
    await ui(`window.fleet.saveSnippets([{ id: 'e', label: 'Email', value: 'fan@example.com', secret: false }, { id: 'p', label: 'Card last 4', value: '4242', secret: true }])`);
    const saved = fs.readFileSync(path.join(userData, 'snippets.json'), 'utf8');
    assert.ok(!saved.includes('4242') && !saved.includes('fan@example.com'), 'snippet values are encrypted on disk');
    assert.deepEqual((await ui('window.fleet.getSnippets()')).map((s) => s.value), ['fan@example.com', '4242']);
    await run('insertText', 'fan@example.com');
    results.inserted = await waitFor(async () => {
      for (const wc of webContents.getAllWebContents()) {
        if (!wc.getURL().includes('fleet-e2e')) continue;
        const value = await wc.executeJavaScript(`document.querySelector('#field')?.value`).catch(() => null);
        if (value) return value;
      }
      return null;
    }, 'inserted text in page');
    assert.equal(results.inserted, 'fan@example.com');

    await ui(`document.querySelector('#snippet-edit').click(); document.querySelector('#snippet-edit').click();`);
    await ui(`window.fleet.getSnippets().then((list) => { snippets = list; renderSnippets(); })`);
    // Profiles: import a CSV (stored encrypted), assign one with its own proxy, autofill a checkout form.
    const csv = [
      'Profile,Name,Email,Address,City,State,Zip Code,Phone Number,Proxy,Card Number,Exp Month,Exp Year,CVV,Group',
      `Alpha,Ann Lee,ann@example.com,1 Main St,Richmond,VA,23220,804-555-0100,127.0.0.1:${proxyPort}:profile-alpha:pw,4111111111111111,3,2028,123,East`,
      'Bravo,Bob Ray,bob@example.com,2 Oak Ave,Albany,NY,12207,518-555-0101,,,,,,East',
    ].join('\n');
    const imported = await ui(`window.fleet.importProfilesText(${JSON.stringify(csv)})`);
    assert.equal(imported.imported, 2);
    const storedProfiles = fs.readFileSync(path.join(userData, 'profiles.json'), 'utf8');
    assert.ok(!storedProfiles.includes('4111111111111111') && !storedProfiles.includes('ann@example.com'), 'profiles are encrypted on disk');
    const listed = await ui('window.fleet.listProfiles()');
    assert.ok(!JSON.stringify(listed).includes('4111111111111111'), 'the window UI never receives full card numbers');

    // Navigating and assigning at once: the proxy switch must reload the page being loaded, not the old one.
    await run('navigate', 'http://fleet-e2e.example/checkout');
    await waitFor(() => ui(`(() => { const s = document.querySelector('#profile-search'); s.value = 'alpha'; s.dispatchEvent(new Event('input')); return document.querySelectorAll('#profile-results li[data-id]').length === 1; })()`), 'profile search');
    // Accounts browse through a proxy from the start-screen pool pinned to them, never the sheet's.
    const userBefore = await ui(`document.querySelector('.tab[aria-selected="true"] .title').textContent`);
    const requestsBeforeAlpha = requests.length;
    await ui(`document.querySelector('#profile-results li[data-id]').click()`);
    const alphaUser = await waitFor(() => requests.slice(requestsBeforeAlpha)
      .find((r) => r.path === '/checkout' && r.user.startsWith('u-us-') && r.user !== userBefore)?.user, 'tab reloads through its pinned pool proxy');
    results.profileProxy = alphaUser;

    const filledTab = await waitFor(async () => {
      for (const wc of webContents.getAllWebContents()) {
        if (wc.getTitle() === alphaUser && !wc.isLoading()) return wc;
      }
      return null;
    }, 'checkout page in profile tab');
    results.autofill = await ui(`window.fleet.invoke('autofill', undefined, 0)`);
    const values = await filledTab.executeJavaScript(`[...document.querySelectorAll('input, select')].map((el) => el.value)`);
    assert.deepEqual(values, ['ann@example.com', 'Ann', 'Lee', '8045550100', '1 Main St', 'Richmond', 'VA', '23220', '4111111111111111', '03', '2028', '123']);
    assert.equal(results.autofill.filled, 12);

    // Duplicating keeps the profile (and its proxy) in a fresh session.
    const profileRequests = requests.filter((r) => r.user === alphaUser).length;
    await run('duplicate');
    await waitFor(() => requests.filter((r) => r.user === alphaUser).length > profileRequests, "duplicate uses the account's pinned proxy");

    // Mass-assign both profiles over every tab, repeating.
    await ui(`window.fleet.invoke('assignProfiles', undefined, { profileIds: ${JSON.stringify(listed.map((p) => p.id))}, repeat: true })`);
    results.profileTags = await waitFor(async () => {
      const tags = await ui(`[...document.querySelectorAll('.tab .profile-tag')].map((el) => el.hidden ? '' : el.textContent)`);
      return tags.every(Boolean) && tags;
    }, 'every tab has a profile');
    // A tab moved off Alpha must not keep exiting through Alpha's proxy.
    const tooltips = await ui(`[...document.querySelectorAll('.tab')].map((el) => el.title)`);
    for (const tip of tooltips) {
      const proxyLine = tip.split('\n').find((line) => line.startsWith('Proxy:')) ?? '';
      assert.equal(proxyLine.includes(alphaUser), tip.includes('Profile: Alpha'), `proxy matches profile: ${tip}`);
    }
    assert.ok(!requests.some((r) => r.user === 'profile-alpha'), "the sheet's proxy is never used");

    // Manual profiles: create one in the editor with a login password and a card, then autofill a login page.
    await ui(`document.querySelector('#profile-new').click()`);
    await ui(`(() => {
      const f = document.querySelector('#profile-editor').elements;
      Object.assign(f.profile, { value: 'Charlie' });
      Object.assign(f.name, { value: 'Cara Diaz' });
      Object.assign(f.email, { value: 'cara@example.com' });
      Object.assign(f.password, { value: 'S3cret!pass' });
      Object.assign(f.cardNumber, { value: '4242 4242 4242 4242' });
      Object.assign(f.cardMonth, { value: '7' });
      Object.assign(f.cardYear, { value: '2029' });
      Object.assign(f.cardCvv, { value: '321' });
      document.querySelector('#card-add').click();
      document.querySelector('#profile-editor button[type="submit"]').click();
    })()`);
    const charlie = await waitFor(async () => (await ui('window.fleet.listProfiles()')).find((p) => p.profile === 'Charlie'), 'manual profile saved');
    assert.equal(charlie.hasPassword, true);
    assert.deepEqual(charlie.cards.map((c) => [c.last4, c.expMonth, c.expYear]), [['4242', '07', '2029']]);
    assert.ok(!JSON.stringify(charlie).includes('S3cret'), 'the window never receives the password');
    const storedAfterManual = fs.readFileSync(path.join(userData, 'profiles.json'), 'utf8');
    assert.ok(!storedAfterManual.includes('S3cret') && !storedAfterManual.includes('cara@example.com'), 'manual profile is encrypted on disk');

    await run('navigate', 'http://fleet-e2e.example/login');
    await waitFor(() => ui(`(() => { const s = document.querySelector('#profile-search'); s.value = 'charlie'; s.dispatchEvent(new Event('input')); return document.querySelectorAll('#profile-results li[data-id]').length === 1; })()`), 'charlie search');
    await ui(`document.querySelector('#profile-results li[data-id]').click()`);
    const loginTab = await waitFor(async () => {
      for (const wc of webContents.getAllWebContents()) {
        if (wc.getURL().endsWith('/login') && !wc.isLoading() && wc.session.storagePath?.includes('profile-')) return wc;
      }
      return null;
    }, 'login page in Charlie\'s session');
    results.loginAutofill = await ui(`window.fleet.invoke('autofill', undefined, 0)`);
    results.loginValues = await loginTab.executeJavaScript(`[...document.querySelectorAll('input')].map((el) => el.value)`);
    assert.deepEqual(results.loginValues, ['cara@example.com', 'S3cret!pass', ''], 'login filled, sign-up password left empty');

    // Editing without retyping keeps the password; removing the card removes it.
    // The panel shows only this tab's profile, Jancy-style: label/value rows with copy buttons.
    await ui(`document.querySelector('#panel-toggle').getAttribute('aria-pressed') === 'true' || document.querySelector('#panel-toggle').click()`);
    results.details = await waitFor(() => ui(`(() => {
      const rows = [...document.querySelectorAll('#profile-details .pd-row')].map((r) => [r.querySelector('.pd-label').textContent, r.querySelector('.pd-value').value]);
      return rows.length ? rows : null;
    })()`), 'profile details rows');
    assert.deepEqual(results.details.find(([label]) => label === 'Email'), ['Email', 'cara@example.com']);
    assert.deepEqual(results.details.find(([label]) => label === 'Password'), ['Password', '••••••••']);
    fs.writeFileSync(path.join(outDir, 'profile-details.png'), (await win.webContents.capturePage()).toPNG());
    // Secrets are copied by the main process; the window only learns that it worked.
    results.copySecret = await ui(`window.fleet.invoke('copySecret', undefined, 'password')`);
    assert.deepEqual(results.copySecret, { ok: true });
    assert.deepEqual(await ui(`window.fleet.invoke('copySecret', undefined, 'bogus')`), { error: 'Unknown field bogus.' });

    await ui(`document.querySelector('#profile-details [data-action="menu"]').click()`);
    await ui(`document.querySelector('#profile-menu button[data-action="edit"]').click()`);
    await ui(`document.querySelector('#panel').scrollTop = 0`);
    fs.writeFileSync(path.join(outDir, 'profile-editor.png'), (await win.webContents.capturePage()).toPNG());
    await ui(`(() => {
      document.querySelector('#editor-cards button[data-saved="0"]').click();
      document.querySelector('#profile-editor').elements.phone.value = '804-555-0199';
      document.querySelector('#profile-editor button[type="submit"]').click();
    })()`);
    const edited = await waitFor(async () => {
      const p = (await ui('window.fleet.listProfiles()')).find((x) => x.profile === 'Charlie');
      return p?.phone === '8045550199' && p;
    }, 'edited profile saved');
    assert.equal(edited.hasPassword, true, 'blank password field keeps the saved password');
    assert.equal(edited.cards.length, 0, 'removed card is gone');
    results.manualProfile = { hasPassword: edited.hasPassword, cards: edited.cards.length, phone: edited.phone };

    fs.writeFileSync(path.join(outDir, 'tools-panel.png'), (await win.webContents.capturePage()).toPNG());

    // Settings: opened from the ⋯ menu; the page view is hidden while it's open so it can't cover it.
    await ui(`document.querySelector('#settings-open').click()`);
    await waitFor(() => ui(`!document.querySelector('#settings-sheet').hidden`), 'settings open');
    const pageViews = () => win.contentView.children;
    await waitFor(() => pageViews().length > 0 && pageViews().every((v) => !v.getVisible()), 'page hidden behind settings');
    results.settings = await ui(`({
      version: document.querySelector('#app-version').textContent,
      state: document.querySelector('#update-state').textContent,
      checkDisabled: document.querySelector('#settings-check').disabled,
      notify: document.querySelector('#setting-notify').checked,
      autoDownload: document.querySelector('#setting-autodownload').checked,
    })`);
    assert.deepEqual(results.settings, {
      version: app.getVersion(), state: 'Updates are only available in the installed app.',
      checkDisabled: true, notify: true, autoDownload: true,
    });
    fs.writeFileSync(path.join(outDir, 'settings.png'), (await win.webContents.capturePage()).toPNG());

    // Toggling a setting persists it.
    await ui(`document.querySelector('#setting-autodownload').click()`);
    await waitFor(() => {
      try { return JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')).autoDownload === false; } catch { return false; }
    }, 'auto-download setting saved');

    // An update that's been downloaded shows "Restart & install" in Settings and in the banner.
    const downloaded = { version: app.getVersion(), supported: true, settings: { autoDownload: false, notifyUpdates: true }, status: { kind: 'downloaded', version: '9.9.9' }, lastChecked: Date.now() };
    win.webContents.send('update-status', downloaded);
    await waitFor(() => ui(`!document.querySelector('#settings-install').hidden && !document.querySelector('#update-banner').hidden`), 'update ready shown');
    assert.match(await ui(`document.querySelector('#update-text').textContent`), /9\.9\.9 is ready/);
    // The test window is hidden, which freezes CSS animations at their first frame; skip them for the capture.
    await ui(`document.head.append(Object.assign(document.createElement('style'), { textContent: '*{animation:none!important}' }))`);
    fs.writeFileSync(path.join(outDir, 'settings-update-ready.png'), (await win.webContents.capturePage()).toPNG());

    // Notifications off: no banner, Settings still shows the update.
    win.webContents.send('update-status', { ...downloaded, settings: { autoDownload: false, notifyUpdates: false } });
    await waitFor(() => ui(`document.querySelector('#update-banner').hidden && !document.querySelector('#settings-install').hidden`), 'banner muted');

    await ui(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await waitFor(() => ui(`document.querySelector('#settings-sheet').hidden`), 'settings closed with Esc');
    await waitFor(() => pageViews().some((v) => v.getVisible()), 'page visible again');

    // Orders: without credentials the screen points to Settings.
    await ui(`document.querySelector('#orders-open').click()`);
    await waitFor(() => pageViews().every((v) => !v.getVisible()) && ui(`/Settings first/.test(document.querySelector('#orders-empty').textContent)`), 'orders asks for setup');
    await ui(`document.querySelector('#orders-empty button').click()`);
    await waitFor(() => ui(`!document.querySelector('#settings-sheet').hidden && document.querySelector('#orders-sheet').hidden`), 'settings opened from orders');
    // Save credentials and test them.
    await ui(`(() => {
      const f = document.querySelector('#sync-form').elements;
      f.companyId.value = '4242';
      f.apiToken.value = 'sync-test-token';
      document.querySelector('#sync-test').click();
    })()`);
    results.syncTest = await waitFor(() => ui(`(() => { const t = document.querySelector('#sync-status').textContent; return /Connected —/.test(t) && t; })()`), 'sync test passes');
    assert.equal(results.syncTest, 'Connected — 120 orders on your account.');
    const storedSync = fs.readFileSync(path.join(userData, 'sync.json'), 'utf8');
    assert.ok(!storedSync.includes('sync-test-token') && storedSync.includes('4242'), 'token is stored encrypted');
    assert.ok(!(await ui(`window.fleet.getSyncSettings().then(JSON.stringify)`)).includes('sync-test-token'), 'the window never gets the token');
    await ui(`document.querySelector('#settings-close').click()`);

    // Nothing polls Sync in the background: orders are fetched only when the screen is opened.
    const requestsAfterSetup = syncRequests.length;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(syncRequests.length, requestsAfterSetup, 'no background requests to Sync');

    // The Orders screen shows the last 25 invoiced orders, newest first.
    SYNC_ORDERS.unshift({ ...SYNC_ORDERS[5], id: 99999, order_id: '799999999', status: 'invoiced', event_name: 'Bad Bunny', occurs_at: '2027-02-14T20:00:00', order_date: new Date().toISOString().slice(0, 19) });
    await ui(`document.querySelector('#orders-open').click()`);
    await waitFor(() => ui(`document.querySelectorAll('#orders-table tbody tr').length === 4`), 'invoiced orders only');
    assert.deepEqual(
      [syncRequests.at(-1).query.status, syncRequests.at(-1).query.limit, syncRequests.at(-1).query.order_by_direction],
      ['invoiced', '25', 'desc'],
    );
    assert.equal(await ui(`document.querySelector('#orders-table tbody tr .event strong').textContent`), 'Bad Bunny');
    await ui(`document.querySelectorAll('#orders-table tbody tr')[2].click()`);
    results.orderDetail = await waitFor(() => ui(`(() => {
      const d = document.querySelector('#order-detail');
      return !d.hidden && [...d.querySelectorAll('dt')].map((dt) => dt.textContent + '=' + dt.nextElementSibling.querySelector('span').textContent);
    })()`), 'order details');
    assert.ok(results.orderDetail.includes('Order Id=700000001'), JSON.stringify(results.orderDetail));
    assert.ok(results.orderDetail.includes('Total=$241.00'));
    assert.ok(results.orderDetail.includes('Auto Fulfill=Yes'), 'fields outside the headline groups are shown too');
    await ui(`document.head.append(Object.assign(document.createElement('style'), { textContent: '*{animation:none!important}' }))`);
    await ui(`document.head.append(Object.assign(document.createElement('style'), { textContent: '*{animation:none!important}' }))`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.writeFileSync(path.join(outDir, 'orders.png'), (await win.webContents.capturePage()).toPNG());

    // Search asks for a profile first, then opens the event on Ticketmaster in that profile's tab.
    const tabsBefore = await ui(`document.querySelectorAll('.tab').length`);
    await ui(`document.querySelector('#order-detail [data-search]').click()`);
    await waitFor(() => ui(`document.querySelector('#orders-sheet').hidden && !document.querySelector('#profile-picker-menu').hidden && !document.querySelector('#picker-search-context').hidden`), 'profile asked first');
    assert.match(await ui(`document.querySelector('#picker-search-event').textContent`), /^Lakers vs Celtics — .*2026/);
    assert.equal(await ui(`document.querySelectorAll('.tab').length`), tabsBefore, 'no tab until a profile is picked');
    // Esc cancels without opening anything.
    await ui(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await waitFor(() => ui(`document.querySelector('#profile-picker-menu').hidden`), 'picker closed');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await ui(`document.querySelectorAll('.tab').length`), tabsBefore, 'cancelled search opens no tab');
    // Search again and pick Bravo.
    await ui(`document.querySelector('#orders-open').click()`);
    await waitFor(() => ui(`document.querySelectorAll('#orders-table tbody tr').length === 4`), 'orders again');
    await ui(`document.querySelectorAll('#orders-table tbody [data-search]')[2].click()`);
    await waitFor(() => ui(`!document.querySelector('#picker-search-context').hidden`), 'profile asked again');
    await ui(`(() => { const s = document.querySelector('#profile-search'); s.value = 'bravo'; s.dispatchEvent(new Event('input')); })()`);
    await waitFor(() => ui(`document.querySelectorAll('#profile-results li[data-id]').length === 1`), 'bravo in picker');
    await ui(`document.querySelector('#profile-results li[data-id]').click()`);
    await waitFor(() => ui(`document.querySelectorAll('.tab').length === ${tabsBefore + 1}`), 'search tab opened');
    assert.match(await ui(`document.querySelector('.tab[aria-selected="true"]').title`), /Profile: Bravo/, 'search tab uses the picked profile');
    results.searchTab = await waitFor(() => ui(`(() => { const t = document.querySelector('.tab[aria-selected="true"]'); return t && t.title.split('\\n')[1]; })()`), 'search tab url');
    assert.equal(results.searchTab, 'https://www.ticketmaster.com/search?q=Lakers+vs+Celtics&startDate=2026-12-01&endDate=2026-12-01');
    results.searchNote = await waitFor(() => ui(`document.querySelector('#note').value`), 'order details in the tab note');
    assert.equal(results.searchNote, 'Lakers vs Celtics\nVenue: Crypto.com Arena\nDate: 2026-12-01 7:30 PM\nSec 112 · Row F · Qty 2\nOrder #700000001 (viagogo)');
    await run('closeTab');
    await waitFor(() => pageViews().some((v) => v.getVisible()), 'page visible after orders');

    // Home: back to the start page (this tab's profile has no homepage).
    await run('navigate', 'http://fleet-e2e.example/login');
    await waitFor(() => ui(`document.querySelector('#address').value.endsWith('/login')`), 'on another page');
    await ui(`document.querySelector('[data-cmd="home"]').click()`);
    await waitFor(() => ui(`document.querySelector('#address').value === 'http://fleet-e2e.example/'`), 'home goes to the start page');

    // A new tab starts without a profile, so the picker opens for the user to choose one.
    await ui(`(() => { const s = document.querySelector('#profile-search'); s.value = ''; s.dispatchEvent(new Event('input')); })()`);
    await run('newTab');
    await waitFor(() => ui(`!document.querySelector('#profile-picker-menu').hidden && !document.querySelector('#profile-empty').hidden`), 'picker opens on a new tab');
    fs.writeFileSync(path.join(outDir, 'new-tab-picker.png'), (await win.webContents.capturePage()).toPNG());

    // Picking an account with a homepage: the homepage loads only once the account's proxy is in place,
    // and the tab's previous page doesn't replace it afterwards.
    const deltaCSV = [
      'Profile,Name,Email,Proxy,URL,Group,TimeZone',
      `Delta,Dee Fox,dee@example.com,127.0.0.1:${proxyPort}:profile-delta:pw,http://fleet-e2e.example/home-delta,East,America/Denver`,
    ].join('\n');
    await ui(`window.fleet.importProfilesText(${JSON.stringify(deltaCSV)})`);
    await waitFor(() => ui(`window.fleet.listProfiles().then((l) => l.some((p) => p.profile === 'Delta'))`), 'delta imported');
    await ui(`(() => { const s = document.querySelector('#profile-search'); s.value = 'delta'; s.dispatchEvent(new Event('input')); })()`);
    await waitFor(() => ui(`document.querySelectorAll('#profile-results li[data-id]').length === 1`), 'delta in picker');
    await ui(`document.querySelector('#profile-results li[data-id]').click()`);
    await waitFor(() => ui(`document.querySelector('#address').value === 'http://fleet-e2e.example/home-delta'`), 'homepage opened');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(await ui(`document.querySelector('#address').value`), 'http://fleet-e2e.example/home-delta', 'the old page does not replace the homepage');
    const homeHits = requests.filter((r) => r.path === '/home-delta');
    const deltaUser = homeHits[0]?.user;
    assert.ok(deltaUser?.startsWith('u-us-') && deltaUser !== alphaUser && homeHits.every((r) => r.user === deltaUser),
      `homepage only through Delta's pinned pool proxy: ${JSON.stringify(homeHits)}`);

    // The clock: set at Launch to where most proxies are (the pool's are in Chicago), with nothing
    // attached to the tabs; the panel shows each tab's proxy timezone.
    const clockLog = () => fs.readFileSync(process.env.TABSOLO_CLOCK_LOG, 'utf8').split('\n').filter((l, i, a) => i < a.length - 1);
    assert.deepEqual(clockLog(), ['America/Chicago'], 'the clock was set once, at Launch, before the tabs opened');
    assert.ok(webContents.getAllWebContents().every((wc) => !wc.debugger.isAttached()), 'no DevTools connection on any tab');
    const zonePage = await waitFor(() => pageViews().find((v) => v.getVisible())?.webContents, 'visible page');
    assert.equal(await zonePage.executeJavaScript('window.firstZone'), Intl.DateTimeFormat().resolvedOptions().timeZone, 'the page sees the process clock, untouched');
    await waitFor(() => ui(`[...document.querySelectorAll('#profile-details .pd-row')].some((r) => r.textContent.includes('Timezone') && r.querySelector('input').value === 'America/Chicago')`), "Delta's proxy timezone in the panel");
    assert.equal(await ui(`Boolean(document.querySelector('#profile-details .pd-warning'))`), false, 'same as the clock: no warning');
    assert.ok(tzLookups.includes(deltaUser), "looked up through the tab's own proxy");
    const lookupsBefore = tzLookups.length;
    await run('reload');
    await waitFor(() => !zonePage.isLoading(), 'reloaded');
    assert.equal(tzLookups.length, lookupsBefore, 'cached per proxy');
    await ui(`window.fleet.saveSettings({ matchProxyTimezone: false })`);
    assert.deepEqual(clockLog(), ['America/Chicago', ''], 'turning it off puts the computer clock back');
    await ui(`window.fleet.saveSettings({ matchProxyTimezone: true })`);

    // Fill & next fills the form and presses its Continue button.
    await run('navigate', 'http://fleet-e2e.example/signin');
    const signin = await waitFor(async () => {
      const v = pageViews().find((view) => view.getVisible())?.webContents;
      return v && !v.isLoading() && v.getURL().endsWith('/signin') && v;
    }, 'sign-in page');
    results.fillNext = await ui(`window.fleet.invoke('autofillSubmit', undefined, 0)`);
    assert.equal(results.fillNext.submitted, 'Continue', JSON.stringify(results.fillNext));
    await waitFor(() => signin.executeJavaScript('window.clicks.length === 1'), 'button clicked');

    // Popups: web pages open as tabs, local files never do.
    const page = signin;
    const tabsBeforePopups = await ui(`document.querySelectorAll('.tab').length`);
    await page.executeJavaScript(`window.open('file:///etc/hosts'); window.open('chrome://settings')`, true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await ui(`document.querySelectorAll('.tab').length`), tabsBeforePopups, 'file: popups are refused');
    await page.executeJavaScript(`window.open('http://fleet-e2e.example/popup')`, true);
    await waitFor(() => ui(`document.querySelectorAll('.tab').length === ${tabsBeforePopups + 1}`), 'web popup opens as a tab');
    await run('closeTab');

    // Groups never mix: an account moved to another group is signed out of its tab.
    await waitFor(() => ui(`/Profile: Delta/.test(document.querySelector('.tab[aria-selected="true"]').title)`), 'delta tab selected');
    const delta = (await ui('window.fleet.listProfiles()')).find((p) => p.profile === 'Delta');
    // Partial saves (starring, moving group) keep the rest of the profile, cards included.
    const alpha = (await ui('window.fleet.listProfiles()')).find((p) => p.profile === 'Alpha');
    assert.deepEqual((await ui(`window.fleet.saveProfile({ id: ${JSON.stringify(alpha.id)}, favorite: true })`)).errors, []);
    const starred = (await ui('window.fleet.listProfiles()')).find((p) => p.profile === 'Alpha');
    assert.equal(starred.favorite, true);
    assert.deepEqual([starred.email, starred.cards.length, starred.group], [alpha.email, alpha.cards.length, 'East']);
    assert.deepEqual((await ui(`window.fleet.saveProfile({ id: ${JSON.stringify(delta.id)}, group: 'West' })`)).errors, []);
    await waitFor(() => ui(`!/Profile: Delta/.test(document.querySelector('.tab[aria-selected="true"]').title)`), 'moved account signed out');
    assert.match(await ui(`document.querySelector('#notice').textContent`), /signed out/);
    // Two groups can't share a name (switching is confirmed by typing it).
    assert.match((await ui(`window.fleet.renameGroup({ group: 'West', name: 'east' })`)).error, /already called/);
    assert.match((await ui(`window.fleet.renameGroup({ group: 'Nope', name: 'X' })`)).error, /no longer exists/);
    assert.equal((await ui(`window.fleet.renameGroup({ group: 'West', name: 'West team' })`)).name, 'West team');
    // A name only has to be unique within its group.
    const sameName = { profile: 'Delta', name: 'Dan East', email: 'dan@example.com' };
    assert.deepEqual((await ui(`window.fleet.saveProfile(${JSON.stringify({ ...sameName, group: 'East' })})`)).errors, []);
    assert.match((await ui(`window.fleet.saveProfile(${JSON.stringify({ ...sameName, group: 'West' })})`)).errors[0], /West team already has a profile named "Delta"/);
    assert.deepEqual((await ui(`window.fleet.saveProfile({ id: ${JSON.stringify(delta.id)}, notes: 'edited' })`)).errors, [], 'editing one of two same-named profiles works');

    // Clear all: every tab's session is wiped (cookies and site storage), each gets a new IP, all go home.
    const tabViews = () => pageViews().map((v) => v.webContents);
    for (const wc of tabViews()) await wc.executeJavaScript(`localStorage.setItem('k', 'v')`).catch(() => {});
    const tabIds = await ui(`[...document.querySelectorAll('.tab')].map((el) => el.dataset.id)`);
    const proxiesBefore = await ui(`[...document.querySelectorAll('.tab')].map((el) => el.title.split('\\n')[2])`);
    const savedAccounts = (await ui('window.fleet.listProfiles()')).map((p) => p.id);
    const oldCookies = new Set();
    for (const id of savedAccounts) {
      for (const c of await session.fromPartition(`persist:profile-${id}`).cookies.get({})) oldCookies.add(c.value);
    }
    assert.ok(oldCookies.size >= 2, 'accounts have saved cookies before');
    const orphan = path.join(userData, 'Partitions', 'profile-deleted-account');
    fs.mkdirSync(orphan, { recursive: true });
    let asked = null;
    dialog.showMessageBox = async (_win, options) => { asked = options.message; return { response: 0 }; };
    const requestsBefore = requests.length;
    await ui(`document.querySelector('[data-cmd="hardReset"]').click()`);
    await waitFor(() => ui(`/^Cleared \\d+ tabs/.test(document.querySelector('#notice').textContent)`), 'reset done');
    assert.match(asked, /^Clear everything in all \d+ tabs\?$/);
    const folders = () => fs.readdirSync(path.join(userData, 'Partitions')).filter((n) => n.startsWith('profile-'));
    for (const id of savedAccounts) {
      assert.ok(!folders().includes(`profile-${id}`), `the account's old session folder is deleted from disk: ${folders()}`);
    }
    for (const wc of tabViews()) {
      assert.ok(!/Partitions\/profile-[0-9a-f-]{36}$/.test(wc.session.storagePath ?? ''), 'account tabs run in a new session folder');
      const kept = (await wc.session.cookies.get({})).filter((c) => oldCookies.has(c.value));
      assert.deepEqual(kept, [], 'no old cookie in any tab (a new visit may set new ones)');
    }
    assert.equal(fs.existsSync(orphan), false, "a deleted account's saved session is removed from disk");
    results.resetNotice = await ui(`document.querySelector('#notice').textContent`);
    for (const id of tabIds) await ui(`window.fleet.command('selectTab', ${JSON.stringify(id)})`);
    await waitFor(() => requests.length - requestsBefore >= tabIds.length, 'every tab reloaded');
    const afterReset = requests.slice(requestsBefore).filter((r) => r.path !== '/favicon.ico');
    assert.ok(afterReset.every((r) => r.cookie === null), `no cookies survive: ${JSON.stringify(afterReset)}`);
    await waitFor(async () => {
      const urls = await ui(`[...document.querySelectorAll('.tab')].map((el) => el.title.split('\\n')[1])`);
      return urls.every((u) => u === 'http://fleet-e2e.example/' || u === 'http://fleet-e2e.example/home-delta');
    }, 'every tab on its home page');
    for (const wc of tabViews()) {
      await waitFor(() => !wc.isLoading(), 'tab loaded');
      assert.equal(await wc.executeJavaScript(`localStorage.getItem('k')`), null, 'site storage cleared');
      assert.equal(wc.navigationHistory.canGoBack(), false, 'history cleared');
    }
    const proxiesAfter = await ui(`[...document.querySelectorAll('.tab')].map((el) => el.title.split('\\n')[2])`);
    assert.ok(proxiesAfter.some((p, i) => p !== proxiesBefore[i]), `new IPs: ${JSON.stringify([proxiesBefore, proxiesAfter])}`);

    console.log(JSON.stringify({ ok: true, ...results }, null, 2));
    app.exit(0);
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message, results, requests }, null, 2));
    app.exit(1);
  }
});
