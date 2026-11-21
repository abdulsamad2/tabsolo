'use strict';

// Takes the website's screenshots from the real app, on a throwaway data folder with made-up demo accounts:
//   env -u ELECTRON_RUN_AS_NODE TABSOLO_SKIP_LICENSE=1 SHOTS_OUT=/some/folder npx electron scripts/screenshots.js
// The pages inside the tabs come from a local demo server below; nothing here touches real accounts.
// The website uses 3-tabs-coloured, 4-side-panel-autofill, 5-tab-tools and 1-start (tabsolo-site/public/screens).
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs'), http = require('node:http'), os = require('node:os'), path = require('node:path');
const REPO = path.join(__dirname, '..'), OUT = process.env.SHOTS_OUT;
if (!OUT) { console.error('Set SHOTS_OUT to the folder the pictures go in.'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tabsolo-shots-'));
app.setPath('userData', userData);

const accounts = [
  ['Brand A', 'Ads Manager', 'ads@brand-a.example', '#1971c2'], ['Brand B', 'Ads Manager', 'ads@brand-b.example', '#e8590c'],
  ['Store US', 'Seller dashboard', 'ops@store-us.example', '#2f9e44'], ['Store UK', 'Seller dashboard', 'ops@store-uk.example', '#9c36b5'],
  ['Support', 'Help desk', 'team@support.example', '#c92a2a'],
];
let next = 0;
const server = http.createServer((req, res) => {
  let n = Number(/acct=(\d+)/.exec(req.headers.cookie || '')?.[1]);
  if (req.url.includes('favicon')) {
    const a = accounts[Number.isInteger(n) ? n : 0];
    res.writeHead(200, { 'content-type': 'image/svg+xml' });
    return res.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${a[3]}"/><text x="16" y="23" font-family="Arial" font-weight="700" font-size="19" fill="#fff" text-anchor="middle">${a[0][0]}</text></svg>`);
  }
  const headers = { 'content-type': 'text/html; charset=utf-8' };
  const pinned = /[?&]a=(\d)/.exec(req.url);
  if (pinned) { n = Number(pinned[1]); headers['set-cookie'] = `acct=${n}; Path=/`; }
  else if (!Number.isInteger(n)) { n = next++ % accounts.length; headers['set-cookie'] = `acct=${n}; Path=/`; }
  const [name, product, email, color] = accounts[n];
  res.writeHead(200, headers);
  res.end(`<!doctype html><title>${name} · ${product}</title><meta charset=utf-8><link rel=icon href=/favicon.svg>
<body style="margin:0;font:15px/1.5 -apple-system,system-ui,sans-serif;color:#1c2330;background:#f6f7f9">
<header style="display:flex;align-items:center;gap:14px;padding:14px 28px;background:#fff;border-bottom:1px solid #e3e6ea">
  <span style="display:grid;place-items:center;width:34px;height:34px;border-radius:8px;background:${color};color:#fff;font-weight:700">${name[0]}</span>
  <strong style="font-size:17px">${product}</strong><span style="margin-left:auto;color:#5c6675">Signed in as <b style="color:#1c2330">${email}</b></span>
  <span style="display:grid;place-items:center;width:32px;height:32px;border-radius:50%;background:${color}22;color:${color};font-weight:700">${name.split(' ').map((w) => w[0]).join('')}</span>
</header>
<main style="padding:28px;max-width:980px">
  <h1 style="margin:0 0 4px;font-size:26px">${name}</h1><p style="margin:0 0 22px;color:#5c6675">Account overview · today</p>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px">
    ${[['Active campaigns', 12 + n * 3], ['Orders today', 48 + n * 17], ['Open messages', 3 + n]].map(([k, v]) => `<div style="background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:18px"><div style="color:#5c6675;font-size:13px">${k}</div><div style="font-size:30px;font-weight:700;margin-top:4px">${v}</div></div>`).join('')}
  </div>
  <div style="background:#fff;border:1px solid #e3e6ea;border-radius:10px;margin-top:16px;padding:6px 18px">
    ${['Summer launch', 'Retargeting', 'New arrivals', 'Clearance'].map((r, i) => `<div style="display:flex;padding:12px 0;border-bottom:1px solid #eef0f3"><span>${r}</span><span style="margin-left:auto;color:${i % 2 ? '#5c6675' : color};font-weight:600">${i % 2 ? 'Paused' : 'Running'}</span></div>`).join('')}
  </div>
</main>`);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check, label, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const v = await check(); if (v) return v; await sleep(150); }
  throw new Error('Timed out waiting for ' + label);
}
// The tab's page is a separate view on top of the window, so paste each visible view onto the window's own picture.
const hosts = ['ads.brand-a.example', 'ads.brand-b.example', 'seller.store-us.example', 'seller.store-uk.example', 'help.support.example'];
async function shot(win, name) {
  await sleep(700);
  // The app rewrites the address bar on every state update, so tidy it and capture until the tidy one is in the picture.
  const tidy = `(() => { const a = document.querySelector('#address'); if (!a) return true; const i = [...document.querySelectorAll('.tab')].findIndex((t) => t.classList.contains('selected') || t.classList.contains('active') || t.getAttribute('aria-selected') === 'true'); if (/127\\.0\\.0\\.1/.test(a.value)) a.value = 'https://' + ${JSON.stringify(hosts)}[Math.max(0, i)] + '/overview'; return true; })()`;
  let base;
  for (let attempt = 0; attempt < 8; attempt++) {
    await win.webContents.executeJavaScript(tidy);
    base = await win.webContents.capturePage();
    if (!(await win.webContents.executeJavaScript(`/127\\.0\\.0\\.1/.test(document.querySelector('#address')?.value || '')`))) break;
  }
  const out = Buffer.from(base.toBitmap());
  const W = Math.round(Math.sqrt(out.length / 4 * base.getAspectRatio())), H = out.length / 4 / W;
  const f = W / win.getContentSize()[0]; // screen pixels per layout point
  // Only the front-most page view is laid out; background tabs keep old bounds.
  const view = [...win.contentView.children].reverse().find((v) => v.webContents && v.webContents !== win.webContents && (!v.getVisible || v.getVisible()));
  const b = view && view.getBounds();
  if (b && b.width && b.height) {
    const bmp = (await view.webContents.capturePage()).toBitmap();
    const vw = Math.round(b.width * f), vh = bmp.length / 4 / vw, ox = Math.round(b.x * f), oy = Math.round(b.y * f);
    for (let y = 0; y < vh && oy + y < H; y++) bmp.copy(out, ((oy + y) * W + ox) * 4, y * vw * 4, (y * vw + Math.min(vw, W - ox)) * 4);
  }
  fs.writeFileSync(path.join(OUT, name + '.png'), nativeImage.createFromBitmap(out, { width: W, height: H }).toPNG());
  console.log('saved', name, W + 'x' + H);
}

server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ startURL: `http://127.0.0.1:${server.address().port}/`, tabCount: 5, isolation: 'perTab', proxySource: 'none', theme: 'light' }));
  process.env.TABSOLO_CLOCK_LOG = path.join(userData, 'clock.log');
  process.env.SEATSCOUTS_COMPANY_ID = ''; process.env.SEATSCOUTS_API_TOKEN = '';
  require(path.join(REPO, 'src/main.js'));
});

app.whenReady().then(async () => {
  try {
    const win = await waitFor(() => BrowserWindow.getAllWindows()[0], 'window');
    await waitFor(() => !win.webContents.isLoading() && win.webContents.getURL(), 'launcher');
    const ui = (code) => win.webContents.executeJavaScript(code);
    win.setContentSize(1400, 880);
    await waitFor(() => ui(`!document.querySelector('#launcher').hidden`), 'launcher shown');
    const real = await ui(`document.querySelector('[name=startURL]').value`);
    await ui(`document.querySelector('[name=startURL]').value = 'https://ads.example.com/login'`);
    await shot(win, '1-start');
    await ui(`document.querySelector('[name=startURL]').value = ${JSON.stringify('REAL')}`.replace('REAL', real));
    await ui(`document.querySelector('#launch-form button[type=submit]').click()`);
    await waitFor(() => ui(`[...document.querySelectorAll('.tab .title')].filter((t) => t.textContent.includes('·')).length >= 5`), 'five signed-in tabs', 40000);
    await sleep(1500);
    await shot(win, '2-tabs');
    const ids = await ui(`[...document.querySelectorAll('.tab')].map((t) => t.dataset.id || t.dataset.tabId || '')`);
    console.log('tab ids', ids.join(','));
    const cmd = (name, id, arg) => ui(`window.fleet.command(${JSON.stringify(name)}, ${JSON.stringify(id)}, ${JSON.stringify(arg)})`);
    const colors = ['#1c7ed6', '#f76707', '#2f9e44', '#ae3ec9', '#e03131'];
    for (let i = 0; i < ids.length; i++) await cmd('setColor', ids[i], colors[i]);
    await cmd('setTimer', ids[1], 25);
    await cmd('setNote', ids[2], 'Restock check at 3pm. Reply to the two open buyer messages.');
    // Made-up people, the standard 4111… test card number and 555-01xx fictional phone numbers.
    const row = (profile, name, email, n, street, city, st, zip) => [profile, 'Agency clients', name, email, 'demo-password-' + n, '', '', '', '', '+1804555010' + n, street, '', city, st, zip, 'US', '1990-01-1' + n, '4111111111111111', name, '12/28', '123', ''].join(',');
    const csv = ['Profile,Group,Name,Email,Password,Proxy,Proxy 2,SMS Number,TextChest,Phone Number,Address,Address 2,City,State,Zip Code,Country,DOB,Card Number,Card Name,Exp Date,CVV,Notes',
      row('Brand A', 'Alex Morgan', 'ads@brand-a.example', 1, '12 Market St', 'Richmond', 'VA', '23220'), row('Brand B', 'Alex Morgan', 'ads@brand-b.example', 2, '48 Harbor Ave', 'Norfolk', 'VA', '23510'),
      row('Store US', 'Sam Lee', 'ops@store-us.example', 3, '310 Elm Street', 'Austin', 'TX', '78701'), row('Store UK', 'Sam Lee', 'ops@store-uk.example', 4, '77 King Road', 'Denver', 'CO', '80202'),
      row('Support', 'Riley Chen', 'team@support.example', 5, '5 Lake View Dr', 'Madison', 'WI', '53703')].join('\n');
    console.log('import:', JSON.stringify(await ui(`window.fleet.importProfilesText(${JSON.stringify(csv)}).catch((e) => 'ERR ' + e.message)`)).slice(0, 90));
    const listed = await ui(`window.fleet.listProfiles()`);
    const order = ['Brand A', 'Brand B', 'Store US', 'Store UK', 'Support'].map((n) => (listed.profiles || listed).find((p) => (p.profile || p.name || p.label) === n)?.id).filter(Boolean);
    console.log('profiles found:', order.length, '| keys:', Object.keys((listed.profiles || listed)[0] || {}).join(','));
    console.log('assign:', JSON.stringify(await ui(`window.fleet.invoke('assignProfiles', undefined, { profileIds: ${JSON.stringify(order)}, repeat: false }).catch((e) => 'ERR ' + e.message)`)).slice(0, 120));
    await sleep(2500);
    const now = await ui(`[...document.querySelectorAll('.tab')].map((t) => t.dataset.id || t.dataset.tabId || '')`);
    for (let i = 0; i < now.length; i++) await cmd('navigate', now[i], `http://127.0.0.1:${server.address().port}/?a=${i}`);
    await waitFor(() => ui(`['Brand A', 'Brand B', 'Store US', 'Store UK', 'Support'].every((n, i) => (document.querySelectorAll('.tab .title')[i]?.textContent || '').startsWith(n))`), 'each tab on its own account', 30000);
    for (let i = 0; i < now.length; i++) await cmd('setColor', now[i], colors[i]);
    await cmd('setTimer', now[1], 25);
    await cmd('setNote', now[2], 'Restock check at 3pm. Reply to the two open buyer messages.');
    await sleep(1500);
    await ui(`document.querySelectorAll('.tab')[2].click()`); await sleep(1500);
    await shot(win, '3-tabs-coloured');
    await ui(`document.querySelector('#panel-toggle').click()`); await sleep(1200);
    await shot(win, '4-side-panel-autofill');
    console.log('panel text:', (await ui(`document.querySelector('#panel, aside, .panel')?.innerText.replace(/\\s+/g, ' ').slice(0, 500)`)));
    await ui(`document.querySelectorAll('details').forEach((d) => { if (/Tab tools/.test(d.textContent)) d.open = true; })`); await sleep(700);
    await ui(`(() => { const d = [...document.querySelectorAll('details')].find((x) => /Tab tools/.test(x.textContent)); d && d.scrollIntoView({ block: 'start' }); })()`); await sleep(500);
    await shot(win, '5-tab-tools');
  } catch (e) { console.error('FAILED', e.message); }
  app.exit(0);
});
