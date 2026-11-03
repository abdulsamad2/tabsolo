'use strict';

// Google Sheets import end-to-end check, run by test/run-electron-tests.js.
// A local HTTP server pretends to be the Google Sheets host; TabSolo opens the sheet in a tab
// and reads its CSV export via that tab's own session — no OAuth, no tokens.

const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tabsolo-sheets-'));
const outDir = process.env.E2E_OUT ?? userData;
app.setPath('userData', userData);

const SHEET_ID = 'test-sheet-id-abc-123-xyz-0123456789';
// A workbook with two sheets: "WiLL" has no Group column (its accounts are grouped under the sheet's
// name), "Boss" has one and reuses an account name from the first sheet. Boss is laid out like the
// real workbook: a saved card in Passcode CC / EXP / CVV (or only its CVV), a TextChest resolver missing
// its colon, and empty account slots.
const SHEETS = {
  0: [
    'Profile,Name,Email,Password,Phone Number,Card Number,CVV',
    'Alpha,Ann Lee,ann@sheet.test,sheet-password,804-555-0100,4111111111111111,123',
    'Bravo,Bob Ray,bob@sheet.test,another-pass,518-555-0101,,',
  ].join('\n'),
  340165755: [
    'Group,Buyer,Profile,Name,Email,,CC Number:Test 1,CC Exp Date:Test 1,CC CVV:Test 1,,Site:Ticketmaster,,Passcode CC,EXP,CVV,SMS Number',
    'NX SLOT 1,BUYER 1,Alpha,Nia Xu,nia@sheet.test,,,,,,password=$nx-pass,,,,456,3125550100',
    'NX SLOT 1,BUYER 1,Charlie,Cara Diaz,cara@sheet.test,,,,,,"password=$c-pass , smscode=textchestSECRETKEY0123456789abcdef:ticketmaster",,****1926,01/30,789,3125550101',
    'NX SLOT 1,BUYER 1,Delta,,,,,,,,,,,,,',
  ].join('\n'),
};
const HTMLVIEW = 'var items = [];items.push({name: "WiLL", pageUrl: "x", gid: "0",initialSheet: true});'
  + 'items.push({name: "Boss", pageUrl: "x", gid: "340165755",initialSheet: false});';

// Pretend to be docs.google.com. One route serves the sheet page, another serves the CSV export.
const sheetHost = http.createServer((req, res) => {
  if (req.url === `/spreadsheets/d/${SHEET_ID}/edit` || req.url.startsWith(`/spreadsheets/d/${SHEET_ID}/edit#`)) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>Sheet mock</title><p>Signed in</p>');
    return;
  }
  if (req.url === `/spreadsheets/d/${SHEET_ID}/htmlview`) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<script>${HTMLVIEW}</script>`);
    return;
  }
  const exportMatch = /^\/spreadsheets\/d\/([^/]+)\/export\?format=csv(?:&gid=(\d+))?/.exec(req.url);
  if (exportMatch && exportMatch[1] === SHEET_ID) {
    res.writeHead(200, { 'content-type': 'text/csv' });
    res.end(SHEETS[exportMatch[2] ?? 0]);
    return;
  }
  res.writeHead(404);
  res.end();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

sheetHost.listen(0, '127.0.0.1', () => {
  const { port } = sheetHost.address();
  process.env.TABSOLO_SHEETS_BASE = `http://127.0.0.1:${port}`;
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    startURL: 'about:blank', tabCount: 1, isolation: 'perTab', proxySource: 'none',
  }));
  require('../src/main.js');
});

app.whenReady().then(async () => {
  try {
    const win = await waitFor(() => BrowserWindow.getAllWindows()[0], 'window');
    await waitFor(() => !win.webContents.isLoading() && win.webContents.getURL(), 'launcher');
    const ui = (code) => win.webContents.executeJavaScript(code);
    await ui(`document.querySelector('#launch-form button[type=submit]').click()`);
    await waitFor(() => ui(`document.querySelector('#browser') && !document.querySelector('#browser').hidden`), 'browser mode');

    // Open the Google Sheets import form from the Tools panel.
    await ui(`document.querySelector('#panel-toggle').click()`);
    await ui(`document.querySelector('#profile-sheet').click()`);
    await waitFor(() => ui(`!document.querySelector('#sheet-import').hidden`), 'sheet form visible');

    // Submit the sheet URL; the mock host receives it and the sheet tab opens.
    const sheetUrl = `${process.env.TABSOLO_SHEETS_BASE}/spreadsheets/d/${SHEET_ID}/edit`;
    await ui(`(() => {
      const form = document.querySelector('#sheet-import');
      form.elements.url.value = ${JSON.stringify(sheetUrl)};
      form.dispatchEvent(new Event('submit', { cancelable: true }));
    })()`);
    // Wait for the app's own "ready to import" signal, not just the URL — otherwise the import runs
    // before the sheet finishes loading and the late "Sheet opened" notice overwrites the summary.
    await waitFor(() => ui(`/Sheet opened/.test(document.querySelector('#notice').textContent)`), 'sheet tab opened');

    // Click "Import this sheet" and verify profiles were added.
    await ui(`document.querySelector('#sheet-import-run').click()`);
    const imported = await waitFor(async () => {
      const list = await ui('window.fleet.listProfiles()');
      return list.length >= 4 && list;
    }, 'profiles imported from both sheets');
    assert.deepEqual(imported.map((p) => `${p.group}/${p.profile}`).sort(), ['NX SLOT 1/Alpha', 'NX SLOT 1/Charlie', 'WiLL/Alpha', 'WiLL/Bravo']);
    // Wait for the renderer to show the import summary — the profile count above can race ahead of it.
    const notice = await waitFor(async () => {
      const t = await ui(`document.querySelector('#notice').textContent`);
      return /account\(s\)/.test(t) ? t : null;
    }, 'import summary notice shown');
    assert.match(notice, /WiLL: 2 account\(s\), 1 with a card\/CVV/);
    assert.match(notice, /Boss → NX SLOT 1: 2 account\(s\), 2 with a card\/CVV; 1 empty slot\(s\) skipped/);
    assert.match(notice, /Fixed automatically: 1 "textchest" resolver was missing the colon/);
    assert.doesNotMatch(notice, /SECRETKEY|Problems/, 'no API key, and fixes are not problems');

    // Two groups and none chosen yet: the badge asks, and the picker offers no accounts until one is chosen.
    await waitFor(() => ui(`!document.querySelector('#group-badge').hidden && document.querySelector('#group-badge').classList.contains('needs-choice')`), 'badge asks for a group');
    await ui(`document.querySelector('#profile-picker-btn').click()`);
    await waitFor(() => ui(`Boolean(document.querySelector('#picker-choose-group'))`), 'picker asks for a group');
    await ui(`document.querySelector('#picker-choose-group').click()`);
    await waitFor(() => ui(`!document.querySelector('#group-sheet').hidden`), 'group dialog');
    assert.deepEqual(await ui(`[...document.querySelectorAll('#group-list li strong')].map((s) => s.textContent)`), ['NX SLOT 1', 'WiLL']);
    await ui(`document.head.append(Object.assign(document.createElement('style'), { textContent: '*{animation:none!important}' }))`);
    await sleep(300);
    fs.writeFileSync(path.join(outDir, 'group-choose.png'), (await win.webContents.capturePage()).toPNG());
    await ui(`document.querySelector('#group-list li[data-group="WiLL"] [data-action="choose"]').click()`);
    await waitFor(() => ui(`document.querySelector('#group-sheet').hidden && document.querySelector('.group-badge-name').textContent === 'WiLL'`), 'working in WiLL');
    assert.equal(win.getTitle(), 'TabSolo — WiLL', 'the window title shows the group');

    // Only WiLL's accounts are offered; NX accounts are refused even through a direct command.
    await ui(`document.querySelector('#profile-picker-btn').click()`);
    await waitFor(() => ui(`!document.querySelector('#profile-picker-menu').hidden`), 'picker open');
    assert.deepEqual(await ui(`[...document.querySelectorAll('#profile-results li[data-id] strong')].map((s) => s.firstChild.textContent)`), ['Alpha', 'Bravo']);
    await ui(`document.querySelector('#profile-results li[data-id]').click()`);
    await waitFor(() => ui(`/Alpha/.test(document.querySelector('.picker-label').textContent)`), 'WiLL Alpha on the tab');
    const nxAlpha = imported.find((p) => p.profile === 'Alpha' && p.group === 'NX SLOT 1');
    const tabId = await ui(`document.querySelector('.tab[aria-selected="true"]').dataset.id`);
    await ui(`window.fleet.command('setProfile', ${JSON.stringify(tabId)}, ${JSON.stringify(nxAlpha.id)})`);
    await waitFor(() => ui(`/is in NX SLOT 1; this session works in WiLL/.test(document.querySelector('#notice').textContent)`), 'mixing refused');

    // The group is locked for the session: no switching here, only a restart.
    await ui(`document.querySelector('#group-badge').click()`);
    await waitFor(() => ui(`!document.querySelector('#group-sheet').hidden`), 'group dialog');
    assert.equal(await ui(`document.querySelectorAll('#group-list [data-action="choose"]').length`), 0, 'no switching during a session');
    assert.equal(await ui(`document.querySelector('#group-list li.current .group-current-tag').textContent`), '🔒 This session');
    assert.equal(await ui(`!document.querySelector('#group-locked-note').hidden && document.querySelector('#group-restart').textContent`), 'Restart TabSolo…');
    assert.match((await ui(`window.fleet.switchGroup({ group: 'NX SLOT 1' })`)).error, /one group per session/, 'the core refuses too');
    await ui(`document.head.append(Object.assign(document.createElement('style'), { textContent: '*{animation:none!important}' }))`);
    await sleep(300);
    fs.writeFileSync(path.join(outDir, 'group-locked.png'), (await win.webContents.capturePage()).toPNG());

    // Rename: kept in settings, shown on the start screen and in the session.
    await ui(`document.querySelector('#group-list li[data-group="NX SLOT 1"] [data-action="rename"]').click()`);
    await ui(`(() => { const i = document.querySelector('.group-rename-input'); i.value = 'Boss team'; document.querySelector('[data-action="save-name"]').click(); })()`);
    await waitFor(() => ui(`[...document.querySelectorAll('#group-list li strong')].some((s) => s.textContent === 'Boss team')`), 'renamed');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')).groupNames, { 'NX SLOT 1': 'Boss team' });
    await ui(`document.querySelector('#group-close').click()`);

    // Next session: the start screen asks for the group, and Launch needs one.
    await ui(`window.fleet.command('endSession')`);
    await waitFor(() => ui(`!document.querySelector('#launcher').hidden && !document.querySelector('#launch-group').hidden`), 'start screen asks for a group');
    assert.deepEqual(await ui(`[...document.querySelectorAll('#launch-group-list label')].map((l) => l.textContent)`), ['Boss team2 accounts', 'WiLL2 accounts · last used']);
    assert.equal(await ui(`document.querySelectorAll('#launch-group-list input:checked').length`), 0, 'nothing chosen for the user');
    await ui(`document.querySelector('#launch-form button[type=submit]').click()`);
    await waitFor(() => ui(`document.querySelector('#launch-error').textContent === 'Choose the group of accounts to work in.'`), 'launch needs a group');
    assert.equal(await ui(`document.querySelector('#browser').hidden`), true);
    assert.equal(await ui(`window.fleet.launch({ ...${JSON.stringify({})} , startURL: 'http://x.test', tabCount: 1, proxySource: 'none' })`), 'Choose the group of accounts to work in.', 'the core checks too');
    await ui(`document.querySelector('#launch-group-list input[value="NX SLOT 1"]').click()`);
    await ui(`document.head.append(Object.assign(document.createElement('style'), { textContent: '*{animation:none!important}' }))`);
    await sleep(300);
    fs.writeFileSync(path.join(outDir, 'group-start.png'), (await win.webContents.capturePage()).toPNG());
    await ui(`document.querySelector('#launch-form button[type=submit]').click()`);
    await waitFor(() => ui(`!document.querySelector('#browser').hidden && document.querySelector('.group-badge-name').textContent === 'Boss team'`), 'working in Boss team');
    assert.equal(win.getTitle(), 'TabSolo — Boss team');
    assert.ok(!JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')).group, 'the group is not saved as a launch setting');
    await ui(`window.fleet.importFromSheet(${JSON.stringify(sheetUrl)})`);
    assert.equal((await ui('window.fleet.listProfiles()')).length, 4, 're-import updates instead of duplicating');
    assert.equal(await ui(`document.querySelector('.group-badge-name').textContent`), 'Boss team');

    const alpha = imported.find((p) => p.profile === 'Alpha' && p.group === 'WiLL');
    const bravo = imported.find((p) => p.profile === 'Bravo');
    assert.equal(alpha.email, 'ann@sheet.test');
    assert.equal(alpha.phone, '8045550100');
    assert.equal(alpha.hasPassword, true, 'the sheet password is saved');
    assert.deepEqual(alpha.cards.map((c) => c.last4), ['1111']);
    // Boss: a CVV-only saved card, and a last-4 card with its expiry and CVV.
    const nxCards = (await ui('window.fleet.listProfiles()')).filter((p) => p.group === 'NX SLOT 1')
      .map((p) => [p.profile, p.cards.map((c) => [c.last4, c.expMonth, c.expYear, c.hasCvv])]);
    assert.deepEqual(nxCards.sort(), [['Alpha', [['', '', '', true]]], ['Charlie', [['1926', '01', '2030', true]]]]);
    assert.equal(bravo.email, 'bob@sheet.test');
    assert.equal(bravo.hasPassword, true);
    assert.ok(!JSON.stringify(imported).includes('sheet-password'), 'the window never receives the password');

    const storedProfiles = fs.readFileSync(path.join(userData, 'profiles.json'), 'utf8');
    assert.ok(!storedProfiles.includes('sheet-password') && !storedProfiles.includes('4111'), 'imported profiles are encrypted on disk');

    fs.writeFileSync(path.join(outDir, 'sheet-import.png'), (await win.webContents.capturePage()).toPNG());
    console.log(JSON.stringify({ ok: true, imported: imported.map((p) => p.profile) }, null, 2));
    app.exit(0);
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    app.exit(1);
  }
});
