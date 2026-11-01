'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Load .env.local (and .env) before any module reads process.env. Supports KEY=value, KEY="value with
// spaces", comments starting with #, and skips blank lines. Existing env vars win; this never
// overwrites what the shell already set.
for (const file of ['.env.local', '.env']) {
  try {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match || line.trimStart().startsWith('#')) continue;
      const [, key, rawValue] = match;
      const value = rawValue.replace(/^(['"])(.*)\1$/, '$2'); // strip paired quotes
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {}
}

const {
  app, BrowserWindow, WebContentsView, Menu, Notification, clipboard, dialog, ipcMain, net, safeStorage, session,
} = require('electron');
const { randomUUID, randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const { normalizeConfig, validateConfig, createPool, fetchRemoteProxyList, proxyRule, proxyLabel, proxyKey, parseProxy, parseProxyList, toURL } = require('./proxy');
const { checkProxies: checkProxyReputations } = require('./reputation');
const { createOrderWatcher } = require('./orderWatcher');
const { createOrderStatusStore } = require('./orderStatus');
const { checkAll: checkAllAccounts } = require('./accountHealth');
const { ACTIONS, DEFAULT_BY_ID, resolveAccelerators } = require('./shortcuts');
const { buildSeatMatchScript } = require('./seat-match-script');
const { buildRecorderScript } = require('./recorder-script');
const { buildReplayerScript } = require('./replayer-script');
const playbooksStore = require('./playbooks');
const { createLicenseClient } = require('./license/license');
const { createTelemetryClient } = require('./license/telemetry');
const { withoutSecrets, mergeImported, decodeTextFile, parseProfilesCSV, buildProfile, publicProfile, planAssignments, buildAutofillScript, buildSubmitScript, buildCardDigitsScript, chooseShownCard, profilesToCSV } = require('./profiles');
const { resolveForTab } = require('./resolvers');
const { parseSheetURL, csvExportURL, viewURL, isSheetsURL, sheetListURL, parseSheetList } = require('./sheets');
const sync = require('./sync');
const { windowsZoneFor, majorityZone } = require('./clock');
const { execFile, execFileSync } = require('node:child_process');

// Scrub the automation tells out of the UA and client hints before any session is created. Electron's
// default UA is "...TabFleet/1.3.10 Chrome/<ver> Electron/45.0.0 Safari/537.36", which every anti-bot
// stack (Cloudflare, DataDome, Akamai, PerimeterX) treats as a bot. Replace it with the matching stock
// Chrome UA built from Electron's bundled Chromium version so the UA, Sec-CH-UA brands, and the JS
// feature set that pages actually see all agree.
const CHROME_FULL_VERSION = process.versions.chrome;
const CHROME_MAJOR_VERSION = CHROME_FULL_VERSION.split('.')[0];
const UA_OS_TOKEN = process.platform === 'darwin'
  ? 'Macintosh; Intel Mac OS X 10_15_7'
  : process.platform === 'win32'
    ? 'Windows NT 10.0; Win64; x64'
    : 'X11; Linux x86_64';
const CLEAN_USER_AGENT = `Mozilla/5.0 (${UA_OS_TOKEN}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_FULL_VERSION} Safari/537.36`;
const CH_UA_BRANDS = `"Chromium";v="${CHROME_MAJOR_VERSION}", "Google Chrome";v="${CHROME_MAJOR_VERSION}", "Not=A?Brand";v="24"`;
const CH_UA_FULL = `"Chromium";v="${CHROME_FULL_VERSION}", "Google Chrome";v="${CHROME_FULL_VERSION}", "Not=A?Brand";v="24.0.0.0"`;
const CH_UA_PLATFORM = process.platform === 'darwin' ? '"macOS"' : process.platform === 'win32' ? '"Windows"' : '"Linux"';
app.userAgentFallback = CLEAN_USER_AGENT;
// Force Chromium's UI language so navigator.language / navigator.languages don't leak the macOS system
// locale (which shows up as odd combinations like en-KR when the OS region is set to Korea while the
// language is English). Must run before app ready.
const CLEAN_ACCEPT_LANGUAGE = 'en-US,en;q=0.9';
app.commandLine.appendSwitch('lang', 'en-US');
const STEALTH_PRELOAD = path.join(__dirname, 'stealth-preload.js');

// Stable per-session fingerprint seed. Same partition → same seed (so every tab under one profile
// hashes to the same canvas / shows the same WebGL card), different partition → different seed.
// FNV-1a 32-bit over the partition string, formatted as hex.
function partitionSeed(partition) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < partition.length; i++) {
    hash ^= partition.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

// Rewrites the TabFleet/Electron tokens out of request headers for a session. Chromium builds Sec-CH-UA
// from the product name set at compile time, so onBeforeSendHeaders is the only reliable place to
// override it. Idempotent: each session is patched once; later calls for the same session are no-ops.
// Also installs a default-deny permission handler so sites can't silently get mic/camera/geolocation
// — Electron's default-allow leaks mic/camera device labels (incl. "iPhone Microphone"), identifies
// the user's hardware, and shows up as "Audio/Video Permissions: Granted Permanently" on fingerprint
// checks. Stock Chrome prompts for every one of these, so denying matches a fresh profile.
const stealthedSessions = new WeakSet();
function stealthifySession(ses) {
  if (!ses || stealthedSessions.has(ses)) return;
  stealthedSessions.add(ses);
  try { ses.setUserAgent(CLEAN_USER_AGENT); } catch {}
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase();
      if (lower === 'user-agent') headers[key] = CLEAN_USER_AGENT;
      else if (lower === 'sec-ch-ua') headers[key] = CH_UA_BRANDS;
      else if (lower === 'sec-ch-ua-full-version-list') headers[key] = CH_UA_FULL;
      else if (lower === 'sec-ch-ua-platform') headers[key] = CH_UA_PLATFORM;
      else if (lower === 'accept-language') headers[key] = CLEAN_ACCEPT_LANGUAGE;
    }
    callback({ requestHeaders: headers });
  });
  const PRIVACY_DENIED = new Set([
    'media', 'mediaKeySystem', 'geolocation', 'notifications', 'midi', 'midiSysex',
    'serial', 'hid', 'usb', 'bluetooth', 'display-capture', 'camera', 'microphone',
    'background-sync', 'ambient-light-sensor', 'accelerometer', 'gyroscope', 'magnetometer',
    'window-placement', 'window-management', 'local-fonts', 'idle-detection',
  ]);
  try {
    ses.setPermissionRequestHandler((_wc, permission, callback) => callback(!PRIVACY_DENIED.has(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => !PRIVACY_DENIED.has(permission));
    if (typeof ses.setDevicePermissionHandler === 'function') ses.setDevicePermissionHandler(() => false);
  } catch {}
}

const SHARED_PARTITION = 'persist:shared';
// A dedicated persistent session for Google Sheets import tabs: Google sign-in survives restarts and
// stays separate from the user's browsing sessions. Never routed through a proxy.
const SHEETS_PARTITION = 'persist:google-sheets';
const MAX_PROXY_AUTH_ATTEMPTS = 2;
const TIMER_PRESETS = [1, 2, 5, 10, 15, 30, 60];
const TAB_COLORS = [
  ['Red', '#e03131'], ['Orange', '#f76707'], ['Amber', '#f59f00'], ['Yellow', '#fcc419'], ['Lime', '#74b816'],
  ['Green', '#2f9e44'], ['Teal', '#0ca678'], ['Cyan', '#1098ad'], ['Sky', '#339af0'], ['Blue', '#1c7ed6'],
  ['Indigo', '#4263eb'], ['Violet', '#7048e8'], ['Purple', '#ae3ec9'], ['Pink', '#d6336c'], ['Rose', '#f06595'],
  ['Brown', '#8d5524'], ['Olive', '#82c91e'], ['Slate', '#495057'], ['Silver', '#adb5bd'], ['Black', '#111111'],
].map(([name, hex]) => ({ name, hex }));

let win = null;
let overlayOpen = false;
let config = loadConfig();
let mode = 'launcher'; // 'launcher' | 'browser'
let insets = { top: 0, right: 0, left: 0 };

// Browser session state; reset by startSession().
let pool = null;
let sharedProxy = null;
let tabs = [];
// Tab groups: lightweight visual grouping of tabs by { id, name, color, collapsed }. Tabs carry a
// `groupId` that points here; the renderer draws group members contiguous in the strip, prefixed
// by a colored chip. Groups are a renderer-side organization concept — no session or proxy change
// is implied by grouping.
let groups = []; // { id, name, color, collapsed }
let selectedId = null;
let nextSlot = 1;

// Profiles outlive sessions; loaded at startup.
let profiles = [];
// Per-run network state of each profile's session (profile id -> { partition, proxy, region, ready }).
const profileSessions = new Map();

// ---------- Automatiq Sync credentials ----------

// Each user enters their own Company ID + API token in Settings; the token is encrypted with the OS
// keychain and never sent to the window. SEATSCOUTS_COMPANY_ID / SEATSCOUTS_API_TOKEN (e.g. from
// .env.local) are a development fallback — .env.local is not packaged into release builds.
let syncCredentials = null; // { companyId, apiToken } from Settings

async function loadSyncCredentials() {
  try {
    const stored = JSON.parse(fs.readFileSync(dataPath('sync.json'), 'utf8'));
    const apiToken = stored.token
      ? (await safeStorage.decryptStringAsync(Buffer.from(stored.token, 'base64'))).result
      : '';
    syncCredentials = { companyId: String(stored.companyId ?? ''), apiToken };
  } catch {
    syncCredentials = null;
  }
}

function activeSyncCredentials() {
  if (syncCredentials?.companyId && syncCredentials?.apiToken) return { ...syncCredentials, source: 'settings' };
  const companyId = process.env.SEATSCOUTS_COMPANY_ID;
  const apiToken = process.env.SEATSCOUTS_API_TOKEN;
  if (companyId && apiToken) return { companyId, apiToken, source: 'env' };
  return null;
}

function syncSettingsInfo() {
  const active = activeSyncCredentials();
  return {
    companyId: syncCredentials?.companyId ?? '',
    hasToken: Boolean(syncCredentials?.apiToken),
    source: active?.source ?? 'none',
  };
}

async function saveSyncCredentials(input) {
  const companyId = String(input?.companyId ?? '').trim();
  if (companyId && !/^\d{1,12}$/.test(companyId)) return { error: 'Company ID should be a number (Sync → Settings).' };
  let apiToken = syncCredentials?.apiToken ?? '';
  if (input?.clearToken) apiToken = '';
  if (typeof input?.apiToken === 'string' && input.apiToken.trim()) apiToken = input.apiToken.trim();
  syncCredentials = { companyId, apiToken };
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    writeData('sync.json', { companyId });
    return { ...syncSettingsInfo(), warning: 'Your system keychain is unavailable, so the API token is kept only until TabFleet quits.' };
  }
  writeData('sync.json', {
    companyId,
    token: apiToken ? (await safeStorage.encryptStringAsync(apiToken)).toString('base64') : '',
  });
  return syncSettingsInfo();
}

// Local order-status store (new / working / handled). The listSyncOrders response annotates each
// order with its locally-tracked status so the renderer can colour and filter them.
let orderStatusStore = null;
function ensureOrderStatusStore() {
  if (!orderStatusStore) orderStatusStore = createOrderStatusStore(dataPath('order-status.json'));
  return orderStatusStore;
}

async function listSyncOrders(params) {
  const baseURL = process.env.TABFLEET_SYNC_URL || sync.SYNC_BASE_URL;
  const result = await sync.fetchOrders((url, options) => net.fetch(url, options), activeSyncCredentials(), params, baseURL);
  if (Array.isArray(result?.orders)) {
    const store = ensureOrderStatusStore();
    for (const order of result.orders) order.localStatus = store.get(order.id);
  }
  return result;
}

function markOrderStatus(id, status) {
  ensureOrderStatusStore().set(id, status);
  win?.webContents.send('order-status-changed', { id, status });
  return { ok: true };
}

// Order field names from the Automatiq API (snake_case) → the shape eventSearchURL/Note expects
// (camelCase). Having the mapping here keeps the watcher payload interchangeable with what the UI's
// Search button sends in via the `searchEvent` command.
function orderToEvent(order) {
  return {
    eventName: order.event_name,
    occursAt: order.occurs_at,
    venueName: order.venue_name,
    city: order.city,
    section: order.section,
    row: order.row,
    quantity: order.quantity,
    lowSeat: order.low_seat,
    highSeat: order.high_seat,
    orderId: order.order_id ?? order.id,
    marketplace: order.marketplace,
    // Pass through any direct URL Automatiq provided — eventSearchURL prefers it over the TM search
    // fallback, so orders with real event URLs skip the search detour entirely.
    event_url: order.event_url ?? null,
    primary_marketplace_url: order.primary_marketplace_url ?? null,
    ticket_url: order.ticket_url ?? null,
    profileId: null, // the Search action asks for a profile; auto-open leaves it unassigned on purpose
  };
}

// ---------- Order watcher ----------
//
// Polls Automatiq for newly invoiced orders and opens a search tab for each one, re-using the same
// path as the Orders panel's manual Search button. The order record is cached on the tab so the
// Ticketmaster seat-matcher script can read it when that event's actual page later loads.

let orderWatcher = null;
const tabOrderPayload = new WeakMap(); // tab -> order record (for seat-match injection)

function startOrderWatcher() {
  if (orderWatcher?.isRunning()) return;
  orderWatcher = createOrderWatcher({
    seenPath: dataPath('seen-orders.json'),
    listOrders: listSyncOrders,
    onNewOrder: (order) => {
      const event = orderToEvent(order);
      const url = sync.eventSearchURL(event);
      if (!url) return;
      const tab = createTab({ url });
      setNote(tab, sync.eventSearchNote(event));
      tabOrderPayload.set(tab, order);
      ensureOrderStatusStore().touch(order.id);
      notify(`Auto-opened Order #${event.orderId}: ${event.eventName}.`);
    },
    onError: (msg) => notify(`Order watcher: ${msg}`),
  });
  orderWatcher.start();
}

function stopOrderWatcher() {
  if (orderWatcher) { orderWatcher.stop(); orderWatcher = null; }
}

// ---------- Config & snippets ----------

function dataPath(name) {
  return path.join(app.getPath('userData'), name);
}

function loadConfig() {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(dataPath('config.json'), 'utf8')));
  } catch {
    return normalizeConfig();
  }
}

function writeData(name, value) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(dataPath(name), JSON.stringify(value, null, 2));
}

/** Quick-fill snippets; values are encrypted with the OS keychain (macOS Keychain / Windows DPAPI) when available. */
async function loadSnippets() {
  let stored;
  try {
    stored = JSON.parse(fs.readFileSync(dataPath('snippets.json'), 'utf8'));
  } catch {
    return [];
  }
  const list = [];
  for (const snippet of stored) {
    try {
      const value = snippet.encrypted
        ? (await safeStorage.decryptStringAsync(Buffer.from(snippet.encrypted, 'base64'))).result
        : (snippet.value ?? '');
      list.push({ id: snippet.id, label: snippet.label, secret: Boolean(snippet.secret), value });
    } catch {
      // Unreadable on this machine (e.g. copied from another computer); drop it.
    }
  }
  return list;
}

async function saveSnippets(list) {
  const canEncrypt = await safeStorage.isAsyncEncryptionAvailable();
  const stored = [];
  for (const snippet of list) {
    const value = String(snippet.value ?? '');
    stored.push({
      id: snippet.id || randomUUID(),
      label: String(snippet.label ?? '').slice(0, 60),
      secret: Boolean(snippet.secret),
      // Without encryption a secret snippet's value isn't written to disk at all.
      ...(canEncrypt
        ? { encrypted: (await safeStorage.encryptStringAsync(value)).toString('base64') }
        : { value: snippet.secret ? '' : value }),
    });
  }
  writeData('snippets.json', stored);
}

/**
 * Profiles hold card numbers and passwords, so they are stored only encrypted with the OS keychain. If
 * encryption is unavailable, the profiles are saved without their secrets (see withoutSecrets), which stay
 * in memory for this run.
 */
async function loadProfiles() {
  try {
    const stored = JSON.parse(fs.readFileSync(dataPath('profiles.json'), 'utf8'));
    profiles = stored.encrypted
      ? JSON.parse((await safeStorage.decryptStringAsync(Buffer.from(stored.encrypted, 'base64'))).result)
      : (stored.profiles ?? []);
    // Proxies once imported from the sheet's Proxy columns aren't used (the start-screen pool is): drop them.
    if (profiles.some((p) => 'proxy' in p || 'extraProxies' in p || 'proxyIndex' in p)) {
      profiles = profiles.map(({ proxy: _proxy, extraProxies: _backups, proxyIndex: _index, ...rest }) => rest);
      saveProfiles();
    }
  } catch {
    profiles = [];
  }
}

// Saves run one after another, each writing the profiles as they are when it starts: encryption is
// async, so overlapping saves could otherwise finish out of order and an older one overwrite a newer one.
let profileSaves = Promise.resolve();

function saveProfiles() {
  profileSaves = profileSaves.then(writeProfiles, writeProfiles);
  return profileSaves;
}

async function writeProfiles() {
  if (await safeStorage.isAsyncEncryptionAvailable()) {
    const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(profiles));
    writeData('profiles.json', { encrypted: encrypted.toString('base64') });
  } else {
    writeData('profiles.json', { profiles: profiles.map(withoutSecrets) });
    if (!writeProfiles.warned) {
      writeProfiles.warned = true;
      notify("Your system keychain is unavailable, so cards, passwords and proxy passwords are kept only until TabFleet quits. Re-import your profiles after restarting.");
    }
  }
  win?.webContents.send('profiles-changed');
  if (settings) ensureActiveGroup();
}

/**
 * Adds imported profiles, updating ones that already exist. A profile is identified by its group and
 * name, so two groups (sheets) can each have an "OS 1.1"; an older copy saved without a group is
 * updated in place rather than duplicated.
 */
const profileKey = (p) => `${String(p.group ?? '').toLowerCase()}\u0000${p.profile.toLowerCase()}`;

function mergeProfiles(imported) {
  const merged = mergeImported(profiles, imported);
  profiles = merged.profiles;
  return merged.notes;
}

async function importProfilesText(text, options = {}) {
  const { profiles: imported, errors, recognised = {}, ignored = [] } = parseProfilesCSV(text, options);
  const notes = mergeProfiles(imported);
  if (imported.length > 0) await saveProfiles();
  return {
    imported: imported.length, total: profiles.length, notes,
    errors: errors.slice(0, 20),
    recognised: Object.entries(recognised).map(([header, field]) => `${header} → ${field}`),
    ignored,
  };
}

async function importProfilesFile() {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import profiles',
    properties: ['openFile'],
    filters: [{ name: 'Profiles (CSV)', extensions: ['csv', 'tsv', 'txt'] }],
  });
  if (canceled || !filePaths[0]) return null;
  return importProfilesText(decodeTextFile(await fs.promises.readFile(filePaths[0])));
}


/** Creates or updates a profile from the editor; returns `{ errors }` or `{ errors: [], id }`. */
const PROFILE_FIELDS = [
  'profile', 'group', 'site', 'name', 'email', 'phone', 'smsNumber', 'address1', 'address2', 'city', 'state',
  'zip', 'country', 'url', 'dob', 'buyer', 'notes', 'favorite',
];

async function saveProfileFromEditor(input) {
  const existing = input?.id ? findProfile(input.id) : null;
  if (input?.id && !existing) return { errors: ['That profile no longer exists.'] };
  // A partial update (e.g. starring a profile) keeps every field and card it doesn't mention.
  if (existing) {
    input = {
      ...Object.fromEntries(PROFILE_FIELDS.map((key) => [key, existing[key]])),
      keepCards: existing.cards.map((_, index) => index),
      ...input,
    };
  }
  const { profile, errors } = buildProfile(input ?? {}, existing);
  // Names are unique within a group (as on import), so two groups can each have an "OS 1.1".
  if (profiles.some((p) => p.id !== profile.id && profileKey(p) === profileKey(profile))) {
    errors.push(`${groupName(profile.group ?? '')} already has a profile named "${profile.profile}".`);
  }
  if (errors.length > 0) return { errors };

  if (existing) profiles[profiles.indexOf(existing)] = profile;
  else profiles.push(profile);
  await saveProfiles();
  sendState();
  return { errors: [], id: profile.id };
}

async function deleteProfiles(ids) {
  const remove = new Set(ids ?? profiles.map((p) => p.id));
  for (const tab of tabs.filter((t) => remove.has(t.profileId))) await setProfile(tab, null);
  for (const id of remove) {
    profileSessions.delete(id);
    // Deleting a profile also deletes its logins and site data.
    await session.fromPartition(profilePartition(id)).clearStorageData().catch(() => {});
  }
  profiles = profiles.filter((p) => !remove.has(p.id));
  await saveProfiles();
  sendState();
}

function findProfile(id) {
  return profiles.find((p) => p.id === id) ?? null;
}

/**
 * Each profile has its own persistent session (cookies, logins, storage), shared by all of its tabs. Its
 * folder on disk is Partitions/profile-<id>[-<sessionKey>]: Clear all changes the key, so the account
 * starts a brand-new session and the old folder is deleted.
 */
function profilePartition(profileId) {
  const key = findProfile(profileId)?.sessionKey;
  return `persist:profile-${profileId}${key ? `-${key}` : ''}`;
}

// ---------- Groups ----------
//
// The browser works in one group of accounts at a time (settings.activeGroup, the profiles' Group
// value; '' = ungrouped). Only that group's accounts can be put on tabs, so groups never mix. Changing
// group is explicit: the window asks twice (impact, then typing the group's name) and the name is
// checked here too. Display names (settings.groupNames) are separate from the sheet's Group value,
// so renaming survives re-imports.

const GROUP_COLORS = ['#4c6ef5', '#12b886', '#f76707', '#e64980', '#7950f2', '#15aabf', '#fab005', '#82c91e'];
const groupKeyOf = (profile) => profile?.group ?? '';

function groupName(key) {
  return settings.groupNames?.[key] || key || 'Ungrouped';
}

function groupColor(key) {
  let hash = 0;
  for (const ch of String(key)) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  return GROUP_COLORS[Math.abs(hash) % GROUP_COLORS.length];
}

function groupList() {
  const counts = new Map();
  for (const p of profiles) counts.set(groupKeyOf(p), (counts.get(groupKeyOf(p)) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => (a === '') - (b === '') || a.localeCompare(b, undefined, { numeric: true }))
    .map(([key, count]) => ({ key, name: groupName(key), count, color: groupColor(key) }));
}

const hasActiveGroup = () => typeof settings.activeGroup === 'string' && profiles.some((p) => groupKeyOf(p) === settings.activeGroup);
const inActiveGroup = (profile) => Boolean(profile) && hasActiveGroup() && groupKeyOf(profile) === settings.activeGroup;

function persistSettings() {
  writeData('settings.json', settings);
}

function updateWindowTitle() {
  if (!win || win.isDestroyed()) return;
  win.setTitle(hasActiveGroup() ? `TabFleet — ${groupName(settings.activeGroup)}` : 'TabFleet');
}

/** Keeps the active group valid: with a single group it's chosen automatically; otherwise the user picks. */
function ensureActiveGroup() {
  if (!hasActiveGroup()) {
    const keys = [...new Set(profiles.map(groupKeyOf))];
    const next = keys.length === 1 ? keys[0] : null;
    if (settings.activeGroup !== next) {
      settings.activeGroup = next;
      persistSettings();
    }
  }
  // An account edited or re-imported into another group mustn't stay on a tab: groups never mix.
  const strays = tabs.filter((t) => t.profileId && !inActiveGroup(findProfile(t.profileId)));
  for (const tab of strays) setProfile(tab, null, { force: true });
  if (strays.length > 0) {
    notify(`${strays.length} tab${strays.length === 1 ? ' was' : 's were'} signed out: ${strays.length === 1 ? 'its account moved' : 'their accounts moved'} out of the group you're working in.`);
  }
  updateWindowTitle();
  sendState();
}

/**
 * The group is chosen on the start screen and stays for the whole session: accounts of different groups
 * never share a run. To work in another group the user restarts TabFleet (restartForGroup).
 */
const GROUP_LOCKED = 'TabFleet works in one group per session. To use another group, restart TabFleet and choose it on the start screen.';

function setActiveGroup(key) {
  settings.activeGroup = key;
  persistSettings();
  updateWindowTitle();
  sendState();
}

/** Only for a session that has no group yet (e.g. a sheet with several groups was imported during it). */
function switchGroup({ group } = {}) {
  const key = String(group ?? '');
  if (!profiles.some((p) => groupKeyOf(p) === key)) return { error: 'That group no longer exists.' };
  if (hasActiveGroup() && settings.activeGroup === key) return { ok: true };
  if (mode === 'browser' && hasActiveGroup()) return { error: GROUP_LOCKED };
  setActiveGroup(key);
  return { ok: true };
}

/** Closes everything and starts TabFleet again, at the start screen where the group is chosen. */
function restartForGroup() {
  app.relaunch();
  app.quit();
}

function renameGroup({ group, name } = {}) {
  const key = String(group ?? '');
  if (!profiles.some((p) => groupKeyOf(p) === key)) return { error: 'That group no longer exists.' };
  const text = String(name ?? '').trim().slice(0, 40);
  // Switching is confirmed by typing the group's name, so two groups must never share one.
  const taken = groupList().find((g) => g.key !== key && g.name.trim().toLowerCase() === (text || key).toLowerCase());
  if (taken) return { error: `Another group is already called "${taken.name}".` };
  settings.groupNames = { ...(settings.groupNames ?? {}) };
  if (!text || text === key) delete settings.groupNames[key];
  else settings.groupNames[key] = text;
  persistSettings();
  updateWindowTitle();
  sendState();
  return { ok: true, name: groupName(key) };
}

// ---------- Account proxies ----------
//
// Accounts take their IPs from the proxy pool entered on the start screen; proxies in the sheet's Proxy
// columns are kept with the profile but not used for browsing. Bot protection trusts an account that
// keeps the same cookies, device and IP, so the account gets a pool proxy pinned to it (`pinnedProxy`)
// and keeps it on every launch: on a list, one no other account is pinned to; on a rotating gateway, a
// sticky session of its own. A pin is redone only if it no longer belongs to the current pool; New IP
// and Clear all move the account to a fresh pin. A Direct launch puts accounts on the local IP.

function pinBelongsToPool(pin) {
  if (!pin?.proxy || !pool?.enabled) return false;
  if (pool.kind === 'rotating') return pin.gateway === pool.gatewayKey;
  return pool.list.some((p) => proxyKey(p) === proxyKey(pin.proxy));
}

/** Pins a pool proxy to the account (avoiding other accounts' pins and `avoid`) and saves it. */
function pinPoolProxy(profile, region, avoid = null) {
  const taken = new Set(profiles.filter((p) => p.id !== profile.id && p.pinnedProxy).map((p) => proxyKey(p.pinnedProxy.proxy)));
  if (avoid) taken.add(proxyKey(avoid));
  const proxy = pool.pick(region, taken);
  if (!proxy || proxyKey(proxy) === proxyKey(avoid)) return null;
  profile.pinnedProxy = { proxy, gateway: pool.gatewayKey };
  saveProfiles();
  return proxy;
}

/** The proxy an account uses now: its pinned start-screen pool proxy ({ kind: 'pinned' }), or the local IP ({ kind: 'direct' }). */
function accountProxy(profile, region) {
  if (config.startDirect || !pool?.enabled) return { proxy: null, kind: 'direct' };
  if (pinBelongsToPool(profile.pinnedProxy)) return { proxy: profile.pinnedProxy.proxy, kind: 'pinned' };
  const proxy = pinPoolProxy(profile, region);
  return proxy ? { proxy, kind: 'pinned' } : { proxy: null, kind: 'direct' };
}

/** New IP for an account: a fresh pin from the start-screen pool; { error } when there's none to take. */
function nextAccountProxy(profile, current, region) {
  if (!pool?.enabled) return { error: 'There is no start-screen proxy pool to take a new IP from.' };
  const proxy = pinPoolProxy(profile, region, current);
  return proxy ? { proxy, kind: 'pinned' } : { error: 'Every proxy in the start-screen pool is already pinned to an account.' };
}

// Rolling buffer of recent user-facing notices so the status strip's history button can show the
// last 50. Each entry is { text, at }. Non-blocking: a push can happen before win is ready.
const recentNotices = [];
function notify(text) {
  const t = String(text ?? '');
  if (!t) return;
  recentNotices.push({ text: t, at: Date.now() });
  if (recentNotices.length > 50) recentNotices.shift();
  win?.webContents.send('notice', t);
}
function listRecentNotices() { return recentNotices.slice().reverse(); }
ipcMain.handle('notices:recent', () => listRecentNotices());

/** The profile's session for this run, created on first use with the account's proxy (see above). */
function ensureProfileSession(profile) {
  let entry = profileSessions.get(profile.id);
  if (!entry) {
    const region = profile.pinnedProxy?.proxy?.region ?? pool.regions[0] ?? null;
    const chosen = accountProxy(profile, region);
    const partition = profilePartition(profile.id);
    entry = {
      partition, proxy: chosen.proxy, proxyInfo: chosen, region, profileId: profile.id,
      ready: applyProxy(session.fromPartition(partition), chosen.proxy),
    };
    profileSessions.set(profile.id, entry);
  }
  return entry;
}

function profileSessionFor(partition) {
  return [...profileSessions.values()].find((entry) => entry.partition === partition) ?? null;
}

// ---------- Sessions & proxies ----------

/**
 * Points a session at a proxy and drops pooled connections so the next request uses the new exit IP.
 * The auth cache is cleared too: rotating gateways keep the same host, and Chromium would otherwise
 * keep sending the previous session's username.
 */
async function applyProxy(ses, proxy) {
  stealthifySession(ses);
  await ses.setProxy(proxy ? { proxyRules: proxyRule(proxy), proxyBypassRules: '<local>' } : { mode: 'direct' });
  await ses.clearAuthCache();
  await ses.closeAllConnections();
  // Proxied tabs must not advertise this computer's public or LAN IP alongside the proxy's exit IP.
  // disable_non_proxied_udp routes WebRTC through the proxy's TCP transport, so the browserleaks
  // "Local IP" field goes blank and WebRTC can't fingerprint the real public IP. Direct tabs stay on
  // Chromium's default policy to keep real-time apps working.
  const policy = proxy ? 'disable_non_proxied_udp' : 'default';
  for (const tab of tabs) {
    const contents = tab.view?.webContents;
    if (!contents || contents.isDestroyed() || contents.session !== ses) continue;
    try { contents.setWebRTCIPHandlingPolicy(policy); } catch {}
  }
}

// ---------- Session restore ----------
//
// Last session's open tabs are persisted to data/session.json on every structural change (create,
// close, navigate, set-profile, note, color). On the next launch, if the saved session matches the
// current isolation mode + group, startSession reopens those tabs INSTEAD of the configured N blank
// ones. endSession explicitly clears the snapshot — "End session" is a reset, not a pause.

const SESSION_FILE = () => dataPath('session.json');
let saveSessionTimer = null;
function saveSessionState() {
  if (mode !== 'browser') return;
  clearTimeout(saveSessionTimer);
  saveSessionTimer = setTimeout(() => {
    try {
      const payload = {
        isolation: config.isolation,
        activeGroup: settings?.activeGroup ?? null,
        savedAt: Date.now(),
        groups: groups.map((g) => ({ id: g.id, name: g.name, color: g.color, collapsed: g.collapsed })),
        tabs: tabs
          .filter((t) => t.partition !== SHEETS_PARTITION)
          .map((t) => {
            const url = t.view?.webContents?.getURL?.() || t.lastURL || '';
            return {
              url: /^https?:/i.test(url) ? url : (t.lastURL || ''),
              profileId: t.profileId || null,
              color: t.color || null,
              note: t.note || '',
              pinned: Boolean(t.pinned),
              groupId: t.groupId || null,
            };
          })
          .filter((t) => t.url),
      };
      writeData('session.json', payload);
    } catch {}
  }, 500);
}
function clearSessionState() {
  try { fs.unlinkSync(SESSION_FILE()); } catch {}
}
function loadSessionState() {
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE(), 'utf8'));
    if (!data || !Array.isArray(data.tabs)) return null;
    return data;
  } catch { return null; }
}

async function startSession(newConfig) {
  config = newConfig;
  writeData('config.json', config);
  const runtimeConfig = config.proxySource === 'remote'
    ? { ...config, proxySource: 'list', proxyList: await fetchRemoteProxyList(config.remote) }
    : config;
  pool = createPool(runtimeConfig);
  // The clock is set before any tab opens, so every page sees the proxies' timezone from the start.
  if (await applyClock(await sessionClockZone())) return relaunchForClock();
  tabs = [];
  selectedId = null;
  nextSlot = 1;
  sharedProxy = null;
  if (config.isolation === 'shared') {
    sharedProxy = config.startDirect ? null : pool.next();
    await applyProxy(session.fromPartition(SHARED_PARTITION), sharedProxy);
  }
  mode = 'browser';

  // Check for a previous session, but ASK the user before restoring. Auto-restore surprised
  // users with 20 old tabs they didn't want — now it's always a conscious choice. Mismatched
  // isolation / group skips the prompt entirely (the saved tabs wouldn't make sense in the new
  // scope); the saved file is kept until the user explicitly starts fresh.
  const saved = loadSessionState();
  const matches = saved
    && saved.tabs.length > 0
    && saved.isolation === config.isolation
    && saved.activeGroup === (settings?.activeGroup ?? null);
  let restore = false;
  if (matches && win) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: [`Restore ${saved.tabs.length} tabs`, 'Start fresh'],
      defaultId: 0,
      cancelId: 1,
      message: `Restore ${saved.tabs.length} tab${saved.tabs.length === 1 ? '' : 's'} from last session?`,
      detail: 'Your previous tabs, profiles, colors, notes, groups and pinned state will be reopened.',
    });
    restore = response === 0;
    if (!restore) clearSessionState();
  }

  if (restore) {
    groups = Array.isArray(saved.groups) ? saved.groups.map((g) => ({
      id: g.id, name: g.name || 'Group', color: g.color || TAB_GROUP_COLORS[0], collapsed: Boolean(g.collapsed),
    })) : [];
    for (let i = 0; i < saved.tabs.length; i++) {
      const row = saved.tabs[i];
      const tab = createTab({ url: row.url, profileId: row.profileId, select: i === 0 });
      if (row.color) tab.color = row.color;
      if (row.note) setNote(tab, row.note);
      if (row.pinned) tab.pinned = true;
      if (row.groupId && groups.some((g) => g.id === row.groupId)) tab.groupId = row.groupId;
    }
    notify(`Restored ${saved.tabs.length} tab${saved.tabs.length === 1 ? '' : 's'} from last session.`);
  } else {
    for (let i = 0; i < config.tabCount; i++) createTab({ select: i === 0 });
  }
  sendState();
  saveSessionState();
}

function endSession() {
  for (const tab of tabs) destroyTab(tab);
  tabs = [];
  groups = [];
  profileSessions.clear();
  selectedId = null;
  mode = 'launcher';
  clearSessionState();
  sendState();
}

/** Per-tab proxy features need each tab to own its session. */
function perTabProxies() {
  return mode === 'browser' && config.isolation === 'perTab' && Boolean(pool?.enabled);
}

function newPartition() {
  // No "persist:" prefix: an in-memory session that disappears when the app quits.
  return `tab-${randomUUID()}`;
}

/** Clears a private tab session once no tab uses it; persistent sessions (shared, profiles) are kept. */
function releasePartition(partition) {
  if (partition.startsWith('persist:') || tabs.some((t) => t.partition === partition)) return;
  session.fromPartition(partition).clearStorageData().catch(() => {});
}

// ---------- Tabs ----------

function createTab({ url = config.startURL, opener = null, after = null, select = true, profileId = null, fixedPartition = null } = {}) {
  const tab = {
    id: randomUUID(),
    slot: 0,
    partition: SHARED_PARTITION,
    proxy: null,
    region: pool.regions[0] ?? null,
    view: null,
    error: null,
    lastURL: toURL(url),
    pendingURL: null,
    authAttempts: 0,
    color: null,
    note: '',
    timer: null,
    timerDone: false,
    profileId: inActiveGroup(findProfile(profileId)) ? profileId : null,
  };
  let ready = Promise.resolve();
  const profile = opener || fixedPartition ? null : findProfile(tab.profileId);
  if (fixedPartition) {
    // Dedicated persistent session (currently used by Google Sheets import tabs); always direct.
    Object.assign(tab, { partition: fixedPartition, proxy: null, region: null, slot: nextSlot++ });
    ready = applyProxy(session.fromPartition(fixedPartition), null);
  } else if (profile) {
    const entry = ensureProfileSession(profile);
    Object.assign(tab, { partition: entry.partition, proxy: entry.proxy, region: entry.region, slot: nextSlot++ });
    ready = entry.ready;
  } else if (opener) {
    // Popups stay in their opener's session so logins, the IP and the profile carry over.
    Object.assign(tab, {
      partition: opener.partition, proxy: opener.proxy, region: opener.region, slot: opener.slot, color: opener.color,
      profileId: opener.profileId,
    });
  } else if (config.isolation === 'shared') {
    Object.assign(tab, { proxy: sharedProxy, slot: nextSlot++ });
  } else {
    Object.assign(tab, { partition: newPartition(), slot: nextSlot++ });
    tab.proxy = config.startDirect ? null : pool.next(tab.region);
  }

  tab.view = createView(tab);
  if (!opener && !profile && !fixedPartition && config.isolation === 'perTab') ready = applyProxy(tab.view.webContents.session, tab.proxy);

  const anchor = after ? tabs.indexOf(after) : -1;
  if (anchor === -1) tabs.push(tab);
  else tabs.splice(anchor + 1, 0, tab);

  loadWhenReady(tab, ready, url);
  if (select) selectTab(tab.id);
  else sendState();
  return tab;
}

// Fires the TM seat-match overlay when a tab reaches an event or ticket page and we have an order
// pinned to it. Covers primary (ticketmaster.com/event/<id>) and verified-resale (same host, same
// path shape but different seatmap React tree). Idempotent per order id: the injected script tags
// window.__fleetSeatMatch so re-navigation inside the same event doesn't double-install.
// ---------- Recorder ----------
//
// When active, every tab's page gets a listener script injected on each load. The script posts
// click / input / change / submit / keydown events via window.postMessage; stealth-preload.js
// catches those and ipc-sends them here. Events accumulate in `recordedActions` until the user
// stops recording, at which point we write a JSON file into the user data folder and surface the
// path via a notice. Replay is a later feature — this phase is just capturing the ground truth.

let recordingActive = false;
let recordedActions = [];
let recordingStartedAt = 0;

function startRecording() {
  if (recordingActive) return;
  recordingActive = true;
  recordedActions = [];
  recordingStartedAt = Date.now();
  // Inject into every currently-open tab right now.
  for (const tab of tabs) injectRecorderInto(tab);
  notify('Recording started. Do the flow, then click Stop recording.');
  sendState();
}

async function stopRecording({ name = null, orderContext = null } = {}) {
  if (!recordingActive) return null;
  recordingActive = false;
  const actions = autoBindActions(recordedActions, orderContext);
  // Save as a playbook if a name was provided; otherwise still drop a raw recording file so no
  // work is lost. The renderer gives the user a chance to name it when they stop.
  const result = { count: actions.length };
  if (name && name.trim()) {
    try {
      const hostPatterns = Array.from(new Set(actions.map((a) => {
        try { return new URL(a.url || '').hostname; } catch { return null; }
      }).filter(Boolean))).slice(0, 5);
      const pb = playbooksStore.savePlaybook(app.getPath('userData'), {
        name: name.trim(), hostPatterns, actions,
      });
      result.playbook = pb;
      notify(`Saved playbook "${pb.name}" (${pb.actions.length} actions).`);
    } catch (error) {
      notify(`Could not save playbook: ${error.message}`);
    }
  } else {
    const file = dataPath(`recording-${recordingStartedAt}.json`);
    try {
      fs.writeFileSync(file, JSON.stringify({ actions }, null, 2));
      result.file = file;
      notify(`Recorded ${actions.length} actions → ${file}`);
    } catch (error) {
      notify(`Recording stopped but could not be saved: ${error.message}`);
    }
  }
  recordedActions = [];
  sendState();
  return result;
}

// Pulls variable-binding hints from the order the user had in focus when recording started.
function autoBindActions(actions, orderContext) {
  if (!orderContext) return actions;
  return playbooksStore.autoBindVariables(actions, { order: orderContext });
}

function injectRecorderInto(tab) {
  const contents = tab?.view?.webContents;
  if (!contents || contents.isDestroyed()) return;
  contents.executeJavaScript(buildRecorderScript(), true).catch(() => {});
}

// ---------- Playbook replay ----------
//
// Running a playbook against a tab injects the replayer script. Each action can carry a
// `varBinding` that we substitute from the live order before injection. The script posts
// progress back via window.postMessage, which the stealth preload already forwards to the main
// process (same bridge the recorder uses, but tagged with __fleetReplay instead).
//
// Mid-replay the page may navigate; the script bails cleanly and we re-inject on did-navigate so
// multi-page flows (login → event → checkout) can carry through.

const replayRuns = new Map(); // runId → { tabId, playbookId, order, startedAt, log: [] }

// Opens a NEW tab at the given URL and runs the playbook against it once the page settles.
// Useful when the user wants to replay against an arbitrary event URL instead of whatever is on
// the currently selected tab.
async function runPlaybookOnURL(url, playbookId, orderContext = null, { profileId = null } = {}) {
  if (!url || !/^https?:/i.test(url)) return { error: 'Give a valid https:// URL.' };
  const playbook = playbooksStore.readPlaybook(app.getPath('userData'), playbookId);
  if (!playbook) return { error: 'Playbook not found.' };
  const tab = createTab({ url, select: true, profileId });
  // Wait for the tab to finish loading, then kick off the replay. 10s cap so a stuck proxy
  // doesn't hang the UI forever — the replay still runs after that, just maybe on a half-loaded
  // page which the user can then abort.
  const contents = tab.view.webContents;
  await new Promise((resolve) => {
    const done = () => { contents.off('did-stop-loading', done); resolve(); };
    contents.on('did-stop-loading', done);
    setTimeout(done, 10_000);
  });
  return runPlaybookOnTab(tab.id, playbookId, orderContext);
}

/** Walks `actions`, substituting variables against the live order. Seat-click actions with a
 * [lowSeat..highSeat] range get expanded into one click per seat so the full group is carted. */
function materializeActions(actions, order) {
  if (!order) return (actions || []).map((a) => playbooksStore.substitute(a, {}));
  const low = Number(order.lowSeat ?? order.low_seat) || null;
  const high = Number(order.highSeat ?? order.high_seat) || low;
  const seatRange = low && high && high >= low
    ? Array.from({ length: high - low + 1 }, (_, i) => low + i)
    : (low ? [low] : null);
  const out = [];
  for (const action of actions || []) {
    if (action.varBinding?.field === 'seat' && seatRange && seatRange.length > 1 && action.type === 'click') {
      // One click per seat in the range. The target seat's data-seat-name attribute is the only
      // thing that differs between clicks; the rest of the describe() payload stays the same so
      // the replayer finds the right <circle> element each time.
      for (const seatNumber of seatRange) {
        const clone = JSON.parse(JSON.stringify(action));
        if (clone.el?.attrs) {
          if (clone.el.attrs['data-seat-name']) clone.el.attrs['data-seat-name'] = String(seatNumber);
          if (clone.el.attrs['data-seat']) clone.el.attrs['data-seat'] = String(seatNumber);
        }
        out.push(clone);
      }
    } else {
      out.push(playbooksStore.substitute(action, order));
    }
  }
  return out;
}

async function runPlaybookOnTab(tabId, playbookId, orderContext = null) {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return { error: 'Tab not found.' };
  const playbook = playbooksStore.readPlaybook(app.getPath('userData'), playbookId);
  if (!playbook) return { error: 'Playbook not found.' };
  const runId = randomUUID();
  const actions = materializeActions(playbook.actions || [], orderContext || {});
  replayRuns.set(runId, { tabId, playbookId, orderContext, startedAt: Date.now(), log: [], tab });
  tab.playbookRunId = runId;
  const script = buildReplayerScript(actions, { runId, stepDelayMs: 900 });
  try {
    await tab.view.webContents.executeJavaScript(script, true);
    return { ok: true, runId };
  } catch (error) {
    replayRuns.delete(runId);
    return { error: error?.message || 'Replay injection failed.' };
  }
}

// When a page the replayer told the browser to navigate finishes loading, resume the playbook on
// the remaining steps starting from where we left off. We detect "where we left off" by looking at
// the last `log` entry's step index and continuing from there.
function maybeResumeReplayer(tab) {
  if (!tab.playbookRunId) return;
  const run = replayRuns.get(tab.playbookRunId);
  if (!run) return;
  const lastStep = run.log.length ? run.log[run.log.length - 1] : null;
  if (lastStep && (lastStep.status === 'done' || lastStep.status === 'cancelled' || lastStep.status === 'error' || lastStep.status === 'miss')) return;
  const playbook = playbooksStore.readPlaybook(app.getPath('userData'), run.playbookId);
  if (!playbook) return;
  const resumeIndex = lastStep ? lastStep.step + 1 : 0;
  const remaining = materializeActions((playbook.actions || []).slice(resumeIndex), run.orderContext || {});
  if (remaining.length === 0) return;
  const script = buildReplayerScript(remaining, { runId: run.playbookRunId ?? tab.playbookRunId, stepDelayMs: 900 });
  tab.view.webContents.executeJavaScript(script, true).catch(() => {});
}

function stopPlaybook(runId) {
  const run = replayRuns.get(runId);
  if (!run) return;
  replayRuns.delete(runId);
  const tab = tabs.find((t) => t.id === run.tabId);
  if (tab?.view?.webContents && !tab.view.webContents.isDestroyed()) {
    tab.view.webContents.executeJavaScript('window.__fleetReplayRun = null;').catch(() => {});
  }
  if (tab) tab.playbookRunId = null;
}

ipcMain.on('record:action', (event, action) => {
  if (!recordingActive) return;
  const senderTab = tabs.find((t) => t.view?.webContents === event.sender);
  recordedActions.push({
    tabId: senderTab?.id ?? null,
    profileId: senderTab?.profileId ?? null,
    ...action,
  });
  // Cap in-memory recording at a safe ceiling so a runaway page can't blow up memory.
  if (recordedActions.length > 20_000) {
    recordedActions.splice(0, recordedActions.length - 20_000);
  }
  // Tick the UI counter every 5 actions so the Record button shows live progress.
  if (recordedActions.length % 5 === 0) sendState();
});

ipcMain.on('replay:progress', (event, info) => {
  const run = replayRuns.get(info.runId);
  if (!run) return;
  run.log.push(info);
  const tab = tabs.find((t) => t.id === run.tabId);
  const slot = tab?.slot ?? '?';
  if (info.status === 'done' || info.status === 'cancelled') {
    replayRuns.delete(info.runId);
    if (tab) tab.playbookRunId = null;
    notify(`Playbook ${info.status === 'done' ? 'completed' : 'stopped'} on tab ${slot}.`);
  } else if (info.status === 'miss' || info.status === 'error') {
    notify(`Playbook step ${info.step}: ${info.status} — ${info.detail || ''}`);
  } else if (info.status === 'captcha') {
    // Captcha / human-verification detected mid-flow — the operator needs to see this now.
    notify(`Captcha on tab ${slot} — playbook paused. Solve it and press ▶.`);
  } else if (info.status === 'resumed') {
    notify(`Playbook resumed on tab ${slot}.`);
  }
  // Forward to the renderer for a running progress UI.
  win?.webContents.send('playbook-progress', info);
});

// Per-tab URL watcher. The user sets a substring or /regex/ via the context menu; whenever this
// tab navigates to a matching URL, a system notification fires + the tab's "attention" flag flips
// so the strip shows a dot. One-shot per set — resets after firing to avoid spam.
function compileWatch(pattern) {
  if (!pattern) return null;
  const match = /^\/(.+)\/([gimsy]*)$/.exec(pattern);
  try {
    return match ? new RegExp(match[1], match[2]) : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  } catch { return null; }
}
function checkWatchPattern(tab, url) {
  if (!tab.watchPattern) return;
  const re = compileWatch(tab.watchPattern);
  if (!re || !re.test(String(url ?? ''))) return;
  tab.attention = true;
  tab.watchPattern = null; // one-shot
  if (Notification.isSupported()) {
    const n = new Notification({
      title: `Tab ${tab.slot}: watched URL matched`,
      body: url,
    });
    n.on('click', () => { if (win && tabs.includes(tab)) { win.show(); selectTab(tab.id); } });
    n.show();
  }
  notify(`Tab ${tab.slot}: watched URL matched — ${url}`);
  sendState();
}

async function promptWatchPattern(tab) {
  if (!win) return;
  const current = tab.watchPattern || '';
  const buttons = current
    ? ['Save', 'Clear watch', 'Cancel']
    : ['Save', 'Cancel'];
  // Electron doesn't ship a prompt dialog; renderer owns the UI prompt. Delegate via IPC.
  win.webContents.send('prompt-watch', { tabId: tab.id, current });
}

function maybeInjectSeatMatcher(tab, url) {
  const payload = tabOrderPayload.get(tab);
  if (!payload || !url) return;
  if (!/^https:\/\/(www\.)?ticketmaster\.(com|ca|co\.[a-z.]+|[a-z.]+)\/(event|resale|exchange|t)\//i.test(url)) return;
  const script = buildSeatMatchScript(payload);
  tab.view.webContents.executeJavaScript(script, true).catch(() => {});
}

function createView(tab) {
  const view = new WebContentsView({
    webPreferences: {
      partition: tab.partition,
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
      preload: STEALTH_PRELOAD,
      // Runs the stealth preload inside every iframe too. Headless-chrome detectors (HEADCHR_IFRAME)
      // read window.chrome on a child frame; without this the top document is patched but iframes
      // still expose "no chrome" and give the browser away.
      nodeIntegrationInSubFrames: true,
      // Hands the preload a stable per-session fingerprint seed so canvas noise and the picked WebGL
      // vendor/renderer stay the same for every tab in this profile across reloads.
      additionalArguments: [`--fleet-seed=${partitionSeed(tab.partition)}`],
    },
  });
  const contents = view.webContents;
  // Set the WebRTC policy on this view immediately so a page that opens a RTCPeerConnection on load
  // can't harvest the local LAN IP before applyProxy runs its matching call. Proxied → UDP must go
  // through the proxy; direct → Chromium default so real-time apps work.
  try { contents.setWebRTCIPHandlingPolicy(tab.proxy ? 'disable_non_proxied_udp' : 'default'); } catch {}
  // Default-mute every new tab; only the currently selected tab plays audio. The user can flip
  // this per-tab from the context menu.
  try { contents.setAudioMuted(true); } catch {}
  // Page right-click context menu. Chromium leaves this to the embedder, so wire the standard
  // Copy / Paste / Cut / Select All / Undo / Redo / Reload / Open-link items ourselves. Without
  // this the page shows no menu at all when the user right-clicks text, which breaks mouse-driven
  // copy/paste on card numbers etc.
  contents.on('context-menu', (event, params) => {
    const t = [];
    if (params.linkURL) t.push(
      { label: 'Open Link in New Tab', click: () => createTab({ url: params.linkURL, opener: tab, after: tab }) },
      { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
      { type: 'separator' },
    );
    if (params.hasImageContents) t.push(
      { label: 'Copy Image', click: () => contents.copyImageAt(params.x, params.y) },
      { label: 'Save Image As…', click: () => contents.downloadURL(params.srcURL) },
      { type: 'separator' },
    );
    if (params.isEditable) {
      t.push(
        { role: 'undo', enabled: params.editFlags.canUndo },
        { role: 'redo', enabled: params.editFlags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { role: 'selectAll', enabled: params.editFlags.canSelectAll },
      );
    } else if (params.selectionText && params.selectionText.trim()) {
      t.push(
        { role: 'copy' },
        { type: 'separator' },
        { label: `Search "${params.selectionText.slice(0, 30)}" on Google`,
          click: () => createTab({ url: `https://www.google.com/search?q=${encodeURIComponent(params.selectionText)}`, opener: tab, after: tab }) },
      );
    } else {
      t.push(
        { label: 'Back', enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() },
        { label: 'Forward', enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() },
        { label: 'Reload', click: () => contents.reload() },
      );
    }
    if (t.length === 0) return;
    Menu.buildFromTemplate(t).popup({ window: win });
  });
  // Burn swaps a tab's view; events still arriving from the old one must not touch the tab.
  const current = () => tab.view === view;
  const update = () => current() && sendState();
  for (const event of ['page-title-updated', 'did-navigate', 'did-navigate-in-page', 'did-stop-loading']) {
    contents.on(event, update);
  }
  contents.on('page-favicon-updated', (_event, favicons) => {
    if (!current()) return;
    tab.favicon = Array.isArray(favicons) && favicons.length > 0 ? favicons[0] : null;
    sendState();
  });
  // Clear the favicon on navigation so a fast-nav flash from the previous site doesn't linger.
  contents.on('did-start-navigation', (details) => {
    if (!current() || !details.isMainFrame || details.isSameDocument) return;
    tab.favicon = null;
  });
  // The page itself has loaded (ads and trackers may keep going): its load slot is free for the next tab.
  const loaded = () => current() && releaseLoadSlot(tab);
  contents.on('did-finish-load', loaded);
  contents.on('did-stop-loading', loaded);
  // Remember where a main-frame navigation is heading, so a reload during it (e.g. after a proxy switch
  // drops connections) goes to that page rather than the last one that finished loading.
  contents.on('did-start-navigation', (details) => {
    if (current() && details.isMainFrame && !details.isSameDocument) tab.pendingURL = details.url;
  });
  contents.on('did-navigate', (_event, url) => {
    if (!current()) return;
    tab.pendingURL = null;
    maybeInjectSeatMatcher(tab, url);
    if (recordingActive) injectRecorderInto(tab);
    checkWatchPattern(tab, url);
    maybeResumeReplayer(tab);
  });
  contents.on('did-navigate-in-page', (_event, url) => {
    if (!current()) return;
    maybeInjectSeatMatcher(tab, url);
    if (recordingActive) injectRecorderInto(tab);
    checkWatchPattern(tab, url);
  });
  contents.on('did-start-loading', () => {
    if (!current()) return;
    tab.error = null;
    sendState();
  });
  contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (current() && isMainFrame) releaseLoadSlot(tab);
    if (!current() || !isMainFrame || code === -3) return; // -3: aborted (navigated away / download)
    tab.error = `${description || 'Load failed'} (${code})`;
    // Transient network errors (DNS fail, TCP reset, timeout, ERR_PROXY_CONNECTION_FAILED) often
    // succeed on a retry — the proxy pool rotation or a flaky upstream fix themselves after a
    // beat. Retry up to 2 times with escalating backoff, then stop and surface the error.
    const RETRYABLE = new Set([
      -101, // ERR_CONNECTION_RESET
      -105, // ERR_NAME_NOT_RESOLVED
      -106, // ERR_INTERNET_DISCONNECTED
      -118, // ERR_CONNECTION_TIMED_OUT
      -130, // ERR_PROXY_CONNECTION_FAILED
      -324, // ERR_EMPTY_RESPONSE
      -501, // ERR_INSECURE_RESPONSE
    ]);
    // Any failure that smells like the proxy itself cools that proxy down so the next tab (or the
    // same tab's auto-reload) doesn't pick the same bad IP. 5-minute cooldown by default.
    const PROXY_FAILURE_CODES = new Set([-130, -101, -118, -324, -111]);
    if (tab.proxy && pool?.markBad && PROXY_FAILURE_CODES.has(code)) {
      pool.markBad(tab.proxy, `net code ${code}`);
    }
    tab.autoReloadCount = tab.autoReloadCount ?? 0;
    if (RETRYABLE.has(code) && tab.autoReloadCount < 2) {
      tab.autoReloadCount++;
      const delay = 1500 * tab.autoReloadCount; // 1.5s, then 3s
      setTimeout(() => {
        if (!current() || tab.view.webContents.isDestroyed()) return;
        tab.error = `Retrying… (attempt ${tab.autoReloadCount})`;
        sendState();
        const url = intendedURL(tab);
        if (url) tab.view.webContents.loadURL(url).catch(() => {});
      }, delay);
    }
    sendState();
  });
  contents.on('did-finish-load', () => { if (current()) tab.autoReloadCount = 0; });
  contents.on('render-process-gone', (_event, details) => {
    if (!current()) return;
    tab.error = `Page stopped (${details.reason}). Reload to try again.`;
    sendState();
  });
  contents.setWindowOpenHandler(({ url }) => {
    // Pages may only open web pages: a popup loads through the main process, which would otherwise let
    // a site open file: or other local URLs it can't navigate to itself.
    if (/^(https?:|about:blank$)/i.test(url)) createTab({ url, opener: tab, after: tab });
    return { action: 'deny' };
  });
  contents.on('before-input-event', (event, input) => {
    // Electron menus don't see Ctrl+Tab while a page has focus on Windows.
    if (input.type === 'keyDown' && input.control && input.key === 'Tab') {
      event.preventDefault();
      cycleTab(input.shift ? -1 : 1);
    }
  });
  return view;
}

// ---------- Clock ----------
//
// A site sees the IP's location next to the browser's clock, and a US proxy with the computer's Korean
// timezone doesn't add up. Pages get their clock from the computer they run on, so nothing inside the
// browser is changed: at Launch, TabFleet looks up where the proxies' IPs are and sets the clock's
// timezone to theirs, before any tab opens.
// - Windows: the computer's timezone is set with tzutil (allowed for normal users) and put back when
//   TabFleet quits (or on its next start, after a crash).
// - macOS / Linux: changing the computer's timezone needs an admin password, so TabFleet runs its own
//   processes in that timezone (TZ), which only takes effect from a process start: it restarts once and
//   continues the launch, and starts in the same timezone next time.
// Settings → "Set the clock to the proxies' timezone".

const TZ_LOOKUPS = process.env.TABFLEET_TZ_LOOKUP_URL
  ? [process.env.TABFLEET_TZ_LOOKUP_URL]
  : ['https://ipinfo.io/json', 'http://ip-api.com/json/?fields=status,timezone'];
// Where a proxy's region is all that's known (the lookup failed).
const REGION_ZONES = {
  us: 'America/New_York', ca: 'America/Toronto', gb: 'Europe/London', uk: 'Europe/London', ie: 'Europe/Dublin',
  au: 'Australia/Sydney', nz: 'Pacific/Auckland', de: 'Europe/Berlin', fr: 'Europe/Paris', es: 'Europe/Madrid',
  it: 'Europe/Rome', nl: 'Europe/Amsterdam', mx: 'America/Mexico_City',
};
const proxyZones = new Map(); // proxyKey -> Promise<string | null>

function validZone(zone) {
  try {
    return zone ? new Intl.DateTimeFormat('en-US', { timeZone: String(zone) }).resolvedOptions().timeZone : null;
  } catch {
    return null;
  }
}

/** GETs JSON through a session (and so its proxy), answering the proxy's login; null on any failure. */
function fetchJSONVia(ses, url, proxy) {
  return new Promise((resolve) => {
    let request;
    const done = (value) => { clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { request?.abort(); resolve(null); }, 6000);
    try {
      request = net.request({ url, session: ses, useSessionCookies: false, redirect: 'follow' });
    } catch {
      return done(null);
    }
    request.on('login', (authInfo, callback) => {
      if (authInfo.isProxy && proxy?.username) callback(proxy.username, proxy.password ?? '');
      else callback();
    });
    request.on('response', (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => { try { done(JSON.parse(body)); } catch { done(null); } });
      response.on('error', () => done(null));
    });
    request.on('error', () => done(null));
    request.end();
  });
}

/**
 * The timezone of the proxy's exit IP, looked up once per proxy (a sticky session counts as its own
 * proxy). The lookup runs in a throwaway session with the same proxy, so it never touches an account's
 * cookies or cache. A failed lookup is retried after 10 minutes, not on every page load.
 */
function proxyZone(proxy) {
  const key = proxyKey(proxy);
  if (!proxyZones.has(key)) {
    proxyZones.set(key, (async () => {
      const ses = session.fromPartition(`tz-lookup-${randomUUID()}`);
      try {
        await applyProxy(ses, proxy);
        for (const url of TZ_LOOKUPS) {
          const zone = validZone((await fetchJSONVia(ses, url, proxy))?.timezone);
          if (zone) return zone;
        }
      } catch {}
      setTimeout(() => proxyZones.delete(key), 10 * 60 * 1000);
      return null;
    })());
  }
  return proxyZones.get(key);
}

const CLOCK_LOG = process.env.TABFLEET_CLOCK_LOG; // tests: record the clock instead of changing it
let clockZone = null; // the timezone pages see; null = the computer's own

function runText(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 15000 }, (error, stdout) => resolve(error ? null : String(stdout).trim()));
  });
}

/** Up to 6 of the proxies this session's tabs will use: the group's account proxies, then the pool's. */
function sampleProxies() {
  const sample = [];
  const seen = new Set();
  const add = (proxy) => {
    if (!proxy || sample.length >= 6 || seen.has(proxyKey(proxy))) return;
    seen.add(proxyKey(proxy));
    sample.push(proxy);
  };
  for (const profile of profiles.filter(inActiveGroup)) {
    add(profile.pinnedProxy?.proxy);
  }
  if (pool?.enabled) {
    if (pool.list.length > 0) pool.list.forEach(add);
    else for (let i = 0; i < 3; i++) add(pool.next(pool.regions[0] ?? null));
  }
  return sample;
}

/** The timezone most of the session's proxies are in; null when tabs start on the local IP. */
async function sessionClockZone() {
  if (!settings.matchProxyTimezone || !pool?.enabled || config.startDirect) return null;
  const zones = await Promise.all(sampleProxies().map((proxy) => Promise.race([proxyZone(proxy), sleep(6000).then(() => null)])));
  return majorityZone(zones) ?? REGION_ZONES[String(pool.regions[0] ?? '').toLowerCase()] ?? null;
}

async function restoreWindowsClock() {
  if (process.platform !== 'win32' || !settings.restoreZone) return;
  if (await runText('tzutil', ['/s', settings.restoreZone]) !== null) {
    settings.restoreZone = null;
    persistSettings();
  }
}

/** Sets the clock to `zone` (null = the computer's own). Returns true when TabFleet must restart for it. */
async function applyClock(zone) {
  if (CLOCK_LOG) {
    fs.appendFileSync(CLOCK_LOG, `${zone ?? ''}\n`);
    clockZone = zone;
    return false;
  }
  if (process.platform === 'win32') {
    if (!zone) {
      await restoreWindowsClock();
      clockZone = null;
      return false;
    }
    const target = windowsZoneFor(zone);
    if (!target) {
      notify(`Your proxies are in ${zone}, which TabFleet can't set on Windows; the clock stays as it is.`);
      return false;
    }
    const current = await runText('tzutil', ['/g']);
    if (current !== target) {
      if (current && !settings.restoreZone) {
        settings.restoreZone = current;
        persistSettings();
      }
      if (await runText('tzutil', ['/s', target]) === null) {
        notify(`Windows didn't allow changing the timezone to ${zone}; the clock stays as it is.`);
        return false;
      }
      notify(`Clock set to ${zone}, where your proxies are. Windows gets its own timezone back when TabFleet quits.`);
    }
    clockZone = zone;
    return false;
  }
  settings.clockZone = zone;
  persistSettings();
  if ((process.env.TZ ?? '') !== (zone ?? '')) return true;
  clockZone = zone;
  return false;
}

/**
 * Starts TabFleet again with its clock in `zone` (macOS / Linux). Run from `npm start`, the start script
 * does it (exit code 75), so the app stays attached to the terminal.
 */
function restartWithClock(zone) {
  if (zone) process.env.TZ = zone;
  else delete process.env.TZ;
  if (process.env.TABFLEET_RESTART_FILE) {
    fs.writeFileSync(process.env.TABFLEET_RESTART_FILE, JSON.stringify({ tz: zone ?? '' }));
    app.exit(75);
    return;
  }
  app.relaunch();
  app.exit(0);
}

/** Restarts TabFleet in the session's timezone and continues the launch there. */
function relaunchForClock() {
  settings.pendingLaunch = true;
  persistSettings();
  restartWithClock(settings.clockZone);
}

/** The switch in Settings: Windows goes back to its own timezone at once; elsewhere it applies from the next start. */
function clockSettingChanged() {
  if (settings.matchProxyTimezone) {
    if (mode === 'browser') notify("The clock follows your proxies from the next Launch.");
    return;
  }
  if (process.platform === 'win32' || CLOCK_LOG) {
    applyClock(null);
    sendState();
    return;
  }
  settings.clockZone = null;
  persistSettings();
  if (clockZone) notify('The clock goes back to this computer\'s timezone the next time TabFleet starts.');
}

/** Looks up where the tab's proxy is, for the panel (it doesn't change the tab). */
function refreshTabZone(tab) {
  const proxy = tab.proxy;
  if (!proxy) {
    tab.timezone = null;
    return;
  }
  proxyZone(proxy).then((zone) => {
    if (tab.proxy !== proxy || !tabs.includes(tab)) return;
    tab.timezone = zone;
    sendState();
  });
}

// ---------- Load scheduling ----------

// Loading every tab at once (launch, Refresh all, New IPs: all, assigning profiles) makes the tab on
// screen compete with dozens of others for CPU and bandwidth (measured: 15 Ticketmaster tabs made the
// visible one take 20 s instead of ~5 s; far worse on a slower PC through proxies). So the selected tab
// loads immediately and alone, and background tabs queue, loading BACKGROUND_LOADS at a time once it's done.
// A load holds its slot until the page has loaded, failed, or LOAD_SLOT_MS passed (a stuck proxy
// mustn't block the queue). Selecting a waiting tab loads it straight away.
const BACKGROUND_LOADS = 4;
const LOAD_SLOT_MS = 15000;
const loadQueue = [];
const loadSlots = new Map(); // tab -> timeout

function loadInTab(tab, input) {
  const url = toURL(input);
  if (!url) return;
  tab.lastURL = url;
  tab.error = null;
  // The tab's session is still getting its proxy: loading now could reach the site from the wrong IP.
  if (tab.gate) {
    tab.gate.url = url;
    return;
  }
  // Failures are reported through did-fail-load.
  scheduleLoad(tab, () => tab.view.webContents.loadURL(url).catch(() => {}));
}

/**
 * Loads `url` in the tab once `ready` (its session's proxy setup) settles. Navigations asked for
 * meanwhile replace `url` instead of loading early; a newer gate on the tab supersedes this one.
 */
function loadWhenReady(tab, ready, url) {
  const gate = { url };
  tab.gate = gate;
  return Promise.resolve(ready).then(() => {
    if (tab.gate !== gate) return;
    tab.gate = null;
    loadInTab(tab, gate.url);
    refreshTabZone(tab);
  }, (error) => {
    if (tab.gate !== gate) return;
    tab.gate = null;
    tab.error = `Proxy setup failed: ${error.message}`;
    pumpLoads();
  }).finally(sendState);
}

/** The page a tab is on or heading to: a load waiting for the tab to be ready, one under way, else the current page. */
function intendedURL(tab) {
  const contents = tab.view.webContents;
  return tab.gate?.url || tab.pendingURL || contents.getURL() || tab.lastURL;
}

function reloadTab(tab) {
  tab.error = null;
  // Its page loads as soon as the tab is ready.
  if (tab.gate) return;
  const contents = tab.view.webContents;
  if (tab.pendingURL) loadInTab(tab, tab.pendingURL);
  else if (contents.getURL()) scheduleLoad(tab, () => tab.view.webContents.reload());
  else loadInTab(tab, tab.lastURL);
}

function scheduleLoad(tab, start) {
  tab.queuedLoad = start;
  if (tab.id === selectedId) return startQueuedLoad(tab);
  if (!loadQueue.includes(tab)) loadQueue.push(tab);
  pumpLoads();
  sendState();
}

function startQueuedLoad(tab) {
  const start = tab.queuedLoad;
  const queued = loadQueue.indexOf(tab);
  if (queued !== -1) loadQueue.splice(queued, 1);
  tab.queuedLoad = null;
  if (!start || !tabs.includes(tab) || tab.view.webContents.isDestroyed()) return;
  releaseLoadSlot(tab, false);
  loadSlots.set(tab, setTimeout(() => releaseLoadSlot(tab), LOAD_SLOT_MS));
  start();
}

function releaseLoadSlot(tab, pump = true) {
  const timeout = loadSlots.get(tab);
  if (timeout === undefined) return;
  clearTimeout(timeout);
  loadSlots.delete(tab);
  if (pump) pumpLoads();
}

function pumpLoads() {
  const selected = selectedTab();
  // The selected tab goes first, including while it's still being prepared to load.
  const limit = selected && (loadSlots.has(selected) || selected.gate) ? 0 : BACKGROUND_LOADS;
  let background = [...loadSlots.keys()].filter((t) => t !== selected).length;
  while (loadQueue.length > 0 && background < limit) {
    startQueuedLoad(loadQueue[0]);
    background++;
  }
  sendState();
}

/** Drops a closed tab from the load queue and frees its slot. */
function forgetLoads(tab) {
  const queued = loadQueue.indexOf(tab);
  if (queued !== -1) loadQueue.splice(queued, 1);
  tab.queuedLoad = null;
  releaseLoadSlot(tab);
}

function destroyView(view) {
  if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
  if (!view.webContents.isDestroyed()) view.webContents.close();
}

function destroyTab(tab) {
  clearTimer(tab);
  forgetLoads(tab);
  destroyView(tab.view);
}

// Last-closed stack for Cmd+Shift+T. Captured just before destroyTab runs so we have the url,
// profile, color, note, and watchPattern. 20-entry bounded.
const recentlyClosed = [];
function captureClosedTab(tab) {
  const url = tab.view?.webContents?.getURL?.() || tab.lastURL || '';
  if (!url || !/^https?:/i.test(url)) return;
  recentlyClosed.push({
    url, profileId: tab.profileId || null, color: tab.color || null,
    note: tab.note || '', watchPattern: tab.watchPattern || null, at: Date.now(),
  });
  if (recentlyClosed.length > 20) recentlyClosed.shift();
}
function reopenLastClosedTab() {
  const entry = recentlyClosed.pop();
  if (!entry) { notify('No recently closed tabs to reopen.'); return; }
  const tab = createTab({ url: entry.url, profileId: entry.profileId, select: true });
  if (entry.color) tab.color = entry.color;
  if (entry.note) setNote(tab, entry.note);
  if (entry.watchPattern) tab.watchPattern = entry.watchPattern;
  sendState();
}

function closeTab(tab, { force = false } = {}) {
  const index = tabs.indexOf(tab);
  if (index === -1) return;
  if (tab.pinned && !force) {
    notify('Unpin this tab first (right-click → Unpin Tab) before closing.');
    return;
  }
  captureClosedTab(tab);
  tabs.splice(index, 1);
  destroyTab(tab);
  releasePartition(tab.partition);
  // Drop empty groups so stale chips don't linger in the strip.
  if (tab.groupId && !tabs.some((t) => t.groupId === tab.groupId)) {
    groups = groups.filter((g) => g.id !== tab.groupId);
  }
  if (tabs.length === 0) {
    createTab();
    return;
  }
  if (selectedId === tab.id) selectTab((tabs[index] ?? tabs[tabs.length - 1]).id);
  else sendState();
}

/** Copies get their own session but keep the page, color and profile (and so the profile's proxy). */
function duplicateTab(tab) {
  const copy = createTab({ url: intendedURL(tab), after: tab, select: false, profileId: tab.profileId });
  copy.color = tab.color;
  selectTab(copy.id);
}

/** Gives every tab that shares this tab's session (popups, or all tabs of a profile) a new proxy; cookies are kept. */
async function setSessionProxy(tab, proxy, { reload }) {
  for (const t of tabs) {
    if (t.partition === tab.partition) {
      t.proxy = proxy;
      t.authAttempts = 0;
    }
  }
  const entry = profileSessionFor(tab.partition);
  if (entry) entry.proxy = proxy;
  try {
    await applyProxy(tab.view.webContents.session, proxy);
    tabs.filter((t) => t.partition === tab.partition).forEach(refreshTabZone);
    if (reload) reloadTab(tab);
  } catch (error) {
    tab.error = `Proxy switch failed: ${error.message}`;
  }
  sendState();
}

/**
 * Burn: a brand-new session (fresh cookies) on the pool's next IP, reloading the same page. A profile's
 * session is the profile's identity, so burning a profile tab only moves that session to a new IP.
 */
async function burnIP(tab) {
  if (!perTabProxies() || !tabs.includes(tab)) return;
  const accountEntry = profileSessionFor(tab.partition);
  if (accountEntry) {
    const profile = findProfile(accountEntry.profileId);
    if (!profile) return;
    const next = nextAccountProxy(profile, accountEntry.proxy, tab.region);
    if (next.error) return notify(next.error);
    accountEntry.proxyInfo = next;
    return setSessionProxy(tab, next.proxy, { reload: true });
  }
  const url = intendedURL(tab);
  tab.pendingURL = null;
  const oldView = tab.view;
  const oldPartition = tab.partition;

  tab.partition = newPartition();
  tab.proxy = pool.next(tab.region);
  tab.authAttempts = 0;
  tab.error = null;
  tab.view = createView(tab);
  if (tab.id === selectedId) showSelected();
  destroyView(oldView);
  releasePartition(oldPartition);
  await loadWhenReady(tab, applyProxy(tab.view.webContents.session, tab.proxy), url);
}

function burnAll() {
  return Promise.all(tabs.filter((t, i) => tabs.findIndex((o) => o.partition === t.partition) === i).map(burnIP));
}

/** Switch To Proxy: moves a tab between the local IP and a proxy without reloading or losing its session. */
function toggleProxy(tab) {
  if (!perTabProxies()) return;
  const entry = profileSessionFor(tab.partition);
  const profile = entry && findProfile(entry.profileId);
  if (profile) {
    entry.proxyInfo = tab.proxy ? { proxy: null, kind: 'direct' } : accountProxy(profile, tab.region);
    return setSessionProxy(tab, entry.proxyInfo.proxy, { reload: false });
  }
  return setSessionProxy(tab, tab.proxy ? null : pool.next(tab.region), { reload: false });
}

/** Switch Between Regions: picks a proxy in the region and reloads; tabs on the local IP just remember it. */
function setRegion(tab, region) {
  if (!perTabProxies() || !pool.regions.includes(region)) return;
  for (const t of tabs) if (t.partition === tab.partition) t.region = region;
  const entry = profileSessionFor(tab.partition);
  if (entry) entry.region = region;
  if (!tab.proxy) return sendState();
  const profile = entry && findProfile(entry.profileId);
  if (profile) {
    const proxy = pinPoolProxy(profile, region);
    if (!proxy) return notify(`No proxy in ${region.toUpperCase()} is free for ${profile.profile}.`);
    entry.proxyInfo = { proxy, kind: 'pinned' };
    return setSessionProxy(tab, proxy, { reload: true });
  }
  return setSessionProxy(tab, pool.next(region), { reload: true });
}

/** Moves a tab into another session by swapping its view, then loads `url` (default: the page it was on) there. */
async function moveTabToSession(tab, { partition, proxy, region, ready }, url = null) {
  url ??= intendedURL(tab);
  const oldView = tab.view;
  const oldPartition = tab.partition;
  Object.assign(tab, { partition, proxy, region, pendingURL: null, authAttempts: 0, error: null });
  tab.view = createView(tab);
  if (tab.id === selectedId) showSelected();
  destroyView(oldView);
  releasePartition(oldPartition);
  await loadWhenReady(tab, ready, url);
}

/**
 * Assigns a profile to a tab by moving the tab into that profile's own session, so it sees the profile's
 * cookies and logins and uses its IP. Removing the profile gives the tab a fresh private session.
 */
function setProfile(tab, profileId, { force = false, url = null } = {}) {
  const profile = findProfile(profileId);
  if ((profile?.id ?? null) === tab.profileId || mode !== 'browser') {
    if (url && mode === 'browser') loadInTab(tab, url);
    return;
  }
  // Groups never mix: only the active group's accounts go on tabs.
  if (profile && !force && !inActiveGroup(profile)) {
    notify(hasActiveGroup()
      ? `${profile.profile} is in ${groupName(groupKeyOf(profile))}; this session works in ${groupName(settings.activeGroup)}. Restart TabFleet to use another group.`
      : 'Choose the group you are working in first (the group button in the toolbar).');
    return;
  }
  tab.profileId = profile?.id ?? null;
  if (profile) return moveTabToSession(tab, ensureProfileSession(profile), url);
  if (config.isolation === 'shared') {
    return moveTabToSession(tab, { partition: SHARED_PARTITION, proxy: sharedProxy, region: tab.region, ready: Promise.resolve() }, url);
  }
  const partition = newPartition();
  const proxy = config.startDirect ? null : pool.next(tab.region);
  return moveTabToSession(tab, { partition, proxy, region: tab.region, ready: applyProxy(session.fromPartition(partition), proxy) }, url);
}

/** Bulk-safe cookie wipe: for the given tab ids, dedupe by partition, wipe each distinct session
 * once, then force an immediate reload on every selected tab so background tabs don't display
 * stale "logged in" DOM. Used by the toolbar's Clear button and the right-click bulk entry. */
async function clearCookiesOnTabs(tabIds) {
  if (!Array.isArray(tabIds) || tabIds.length === 0) return 0;
  const targets = tabIds.map((id) => tabs.find((t) => t.id === id)).filter(Boolean);
  if (targets.length === 0) return 0;
  const seenPartition = new Set();
  for (const t of targets) {
    if (seenPartition.has(t.partition)) continue;
    seenPartition.add(t.partition);
    try { stopTab(t); await wipeSession(t.view.webContents.session); } catch {}
  }
  for (const t of targets) {
    const contents = t.view?.webContents;
    if (!contents || contents.isDestroyed()) continue;
    try {
      const url = contents.getURL() || t.lastURL;
      if (url) contents.loadURL(url).catch(() => {});
    } catch {}
  }
  sendState();
  return targets.length;
}

/** Wipes a tab's session cookies/storage and reloads. If the tab belongs to a profile every other
 * tab under that same profile also reloads (they share the session). Works on standalone tabs too
 * so bulk "clear cookies" is useful even for non-profile tabs. */
async function clearProfileCookies(tab) {
  if (!tabs.includes(tab)) return;
  const sharing = tabs.filter((t) => t.partition === tab.partition);
  for (const t of sharing) stopTab(t);
  try { await wipeSession(tab.view.webContents.session); } catch {}
  for (const t of sharing) reloadTab(t);
  sendState();
}

/** Stops a tab's page and anything waiting to load in it, so nothing writes cookies back meanwhile. */
function stopTab(tab) {
  tab.gate = null;
  forgetLoads(tab);
  if (!tab.view.webContents.isDestroyed()) tab.view.webContents.stop();
}

/** Everything a site has stored in the session: cookies, storage, caches, service workers, logins, connections. */
async function wipeSession(ses) {
  await ses.clearStorageData();
  await Promise.all([
    ses.clearCache(), ses.clearAuthCache(), ses.clearHostResolverCache(), ses.clearCodeCaches({}).catch(() => {}),
  ]);
  await ses.closeAllConnections();
}

/**
 * Deletes saved sessions on disk that no account uses any more: deleted accounts' and the ones Clear all
 * replaced. A folder Windows still has open is removed on the next start.
 */
async function removeOrphanPartitions() {
  const dir = path.join(app.getPath('userData'), 'Partitions');
  const known = new Set(profiles.map((p) => profilePartition(p.id).replace('persist:', '')));
  let entries = [];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(entries
    .filter((name) => name.startsWith('profile-') && !known.has(name))
    .map((name) => fs.promises.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {})));
}

async function confirmHardReset() {
  if (mode !== 'browser' || !win) return;
  const tab = selectedTab();
  if (!tab) return;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Clear this tab', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'Clear this tab’s cookies and switch its IP?',
    detail: 'Deletes the cookies, site storage, cache and saved logins used by this tab, assigns a new IP from the pool, and reloads the page. Other tabs and other accounts aren’t touched.',
  });
  if (response === 0) await clearThisTab(tab);
}

/**
 * Per-tab reset — the toolbar's "Clear tab" button. Flow:
 *   1. Wipe the session's cookies, storage, cache, service workers.
 *   2. Burn its IP from the pool.
 *   3. Navigate to the profile's home URL (or the global start URL when no profile) — never back to
 *      the page the user was on, since the point of "Clear" is to start fresh.
 */
async function clearThisTab(tab) {
  if (!tabs.includes(tab)) return;
  const contents = tab.view?.webContents;
  if (!contents || contents.isDestroyed()) return;
  const home = findProfile(tab.profileId)?.url || config.startURL || 'about:blank';
  stopTab(tab);
  try { await wipeSession(contents.session); } catch {}
  if (perTabProxies()) {
    // burnIP navigates to the intended URL; set it to the home first so burn lands there, not on
    // the page we're clearing away from.
    tab.pendingURL = home;
    tab.lastURL = home;
    try { await burnIP(tab); } catch {}
  }
  // Always navigate to home at the end — covers the non-perTab-proxies case and reasserts if
  // burnIP's load raced the wipe.
  tab.view.webContents.loadURL(home).catch(() => {});
}

/** Spreads the chosen profiles over all tabs in order; `repeat` cycles them until every tab has one. */
function assignProfiles({ profileIds = [], repeat = false } = {}) {
  const valid = profileIds.filter((id) => inActiveGroup(findProfile(id)));
  return Promise.all(planAssignments(tabs.map((t) => t.id), valid, repeat).map(([tabId, profileId]) => {
    const tab = tabs.find((t) => t.id === tabId);
    return tab && setProfile(tab, profileId);
  }));
}

/**
 * Opens the given Google Sheets URL in a dedicated persistent tab (no proxy), where the user signs in to
 * Google the way they would in any browser. Reuses the existing sheets tab when one is already open.
 */
function openSheetTab(input) {
  if (mode !== 'browser') return { error: 'Start a browsing session first.' };
  const info = parseSheetURL(input);
  if (!info) return { error: 'That does not look like a Google Sheets URL.' };
  const existing = tabs.find((t) => t.partition === SHEETS_PARTITION);
  if (existing) {
    loadInTab(existing, viewURL(info));
    selectTab(existing.id);
    return { ok: true, tabId: existing.id };
  }
  const tab = createTab({ url: viewURL(info), fixedPartition: SHEETS_PARTITION, select: true });
  return { ok: true, tabId: tab.id };
}

/**
 * Reads a Google Sheet and imports it as profiles. The fetch runs in the main process using the sheet
 * session's cookies, so a private sheet works as long as the user has signed in to Google in the sheet
 * tab at any point; a published sheet needs no sign-in at all.
 */
async function importFromSheetURL(input) {
  const info = parseSheetURL(input);
  if (!info) return { error: 'That does not look like a Google Sheets URL.' };
  const sheetUrl = viewURL(info);
  const sheetSession = session.fromPartition(SHEETS_PARTITION);
  stealthifySession(sheetSession);
  const signIn = { error: 'Sign in to Google in the sheet tab, then click Import again.', needsSignIn: true, sheetUrl };

  /** One sheet's CSV, or { error }. */
  const readCSV = async (gid) => {
    const response = await sheetSession.fetch(csvExportURL({ ...info, gid }), { credentials: 'include', redirect: 'follow' });
    if (!info.published && /accounts\.google\.com/.test(response.url)) return signIn;
    if (response.status === 401 || response.status === 403) {
      return {
        error: info.published
          ? 'The sheet is not published to the web, or publication was turned off.'
          : 'Google refused the request. Share the sheet with the account signed in to the sheet tab.',
        needsSignIn: !info.published, sheetUrl,
      };
    }
    if (!response.ok) return { error: `Google returned HTTP ${response.status}.` };
    const csv = await response.text();
    if (!csv || !csv.trim()) return { csv: '' };
    // Google returns a sign-in HTML page in some private-sheet cases without a redirect; detect that.
    if (/^\s*<!doctype html/i.test(csv) || csv.includes('<html')) return signIn;
    return { csv };
  };

  try {
    // Every sheet in the workbook is imported; each one is a group (its Group column, else the sheet's name).
    let sheets = [];
    try {
      const page = await sheetSession.fetch(sheetListURL(info), { credentials: 'include', redirect: 'follow' });
      if (page.ok && !/accounts\.google\.com/.test(page.url)) sheets = parseSheetList(await page.text());
    } catch {
      // Fall back to the single sheet the link points at.
    }
    if (sheets.length <= 1) {
      const one = await readCSV(info.gid);
      if (one.error) return one;
      if (!one.csv) return { error: 'The sheet is empty.' };
      const result = await importProfilesText(one.csv);
      return { ...result, error: result.imported === 0 ? (result.errors[0] ?? 'No profiles found in the sheet.') : null };
    }

    const imported = [];
    const errors = [];
    const summary = [];
    const recognised = {};
    for (const sheet of sheets) {
      const one = await readCSV(sheet.gid);
      if (one.error) return one;
      const parsed = one.csv ? parseProfilesCSV(one.csv, { defaultGroup: sheet.name }) : { profiles: [], errors: [] };
      imported.push(...parsed.profiles);
      errors.push(...parsed.errors.map((e) => `${sheet.name}: ${e}`));
      Object.assign(recognised, parsed.recognised ?? {});
      const groups = [...new Set(parsed.profiles.map((p) => p.group).filter((g) => g && g !== sheet.name))];
      const skipped = parsed.errors.filter((e) => /are required/.test(e)).length;
      const withCvv = parsed.profiles.filter((p) => p.cards.some((c) => c.cvv)).length;
      summary.push(`${sheet.name}${groups.length ? ` → ${groups.join(', ')}` : ''}: ${parsed.profiles.length} account(s), ${withCvv} with a card/CVV${skipped ? `; ${skipped} empty slot(s) skipped (no Name/Email yet)` : ''}`);
    }
    const notes = mergeProfiles(imported);
    if (imported.length > 0) await saveProfiles();
    return {
      imported: imported.length, total: profiles.length, sheets: summary, notes,
      errors: errors.filter((e) => !/are required/.test(e)).slice(0, 20),
      recognised: Object.entries(recognised).map(([header, field]) => `${header} → ${field}`),
      ignored: [],
      error: imported.length === 0 ? 'No profiles found in any sheet.' : null,
    };
  } catch (error) {
    return { error: `Could not read the sheet: ${error.message}.` };
  }
}

/**
 * Fills the visible form in every frame of the tab from its profile. Runs only when the user asks for it
 * and never submits anything.
 */
/** Walks a JSON structure looking for the first string/number value whose key matches `keys`. */
function pickStringFromJSON(data, keys) {
  const lowered = keys.map((k) => k.toLowerCase());
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) { const found = walk(item); if (found) return found; }
      return null;
    }
    if (value && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        if (lowered.includes(key.toLowerCase()) && (typeof nested === 'string' || typeof nested === 'number')) {
          const str = String(nested).trim();
          if (str) return str;
        }
      }
      for (const nested of Object.values(value)) { const found = walk(nested); if (found) return found; }
    }
    return null;
  };
  return walk(data);
}

/**
 * Fetches a value from a user-configured URL. Returns { value, error } so callers can either take the
 * value (autofill) or show the error (Get OTP button). For password mode: looks for a password-like
 * key in JSON, else returns the first non-blank line. For OTP mode: extracts a 4–8 digit sequence.
 */
async function fetchSyncValue(url, authHeader, mode) {
  if (!url) return { value: '' };
  let host = '';
  try { host = new URL(url).host; } catch {}
  try {
    const headers = { Accept: 'application/json, text/plain, */*' };
    if (authHeader) headers.Authorization = authHeader;
    const response = await net.fetch(url, { headers, redirect: 'follow' });
    if (!response.ok) return { value: '', error: `HTTP ${response.status} from ${host}` };
    const text = (await response.text()).trim();
    if (!text) return { value: '', error: `${host} returned an empty body` };
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (mode === 'otp') {
      const haystack = data ? JSON.stringify(data) : text;
      const contextual = haystack.match(/(?:code|otp|pin|password)[^0-9]{0,8}(\d{4,8})/i);
      if (contextual) return { value: contextual[1] };
      const six = haystack.match(/\b\d{6}\b/);
      if (six) return { value: six[0] };
      const any = haystack.match(/\b\d{4,8}\b/);
      if (any) return { value: any[0] };
      return { value: '', error: `No digits found in response (preview: ${text.slice(0, 80).replace(/\s+/g, ' ')})` };
    }
    if (data) {
      const picked = pickStringFromJSON(data, ['password', 'pass', 'pwd', 'secret', 'value']);
      if (picked) return { value: picked };
    }
    const firstLine = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    return firstLine ? { value: firstLine } : { value: '', error: `No usable value in response from ${host}` };
  } catch (error) {
    return { value: '', error: `${host || 'request'} failed: ${error.message}` };
  }
}

/** Diagnoses every sync source for the tab's profile — reports what was tried and what came back. */
async function diagnoseSync(tab) {
  const profile = findProfile(tab.profileId);
  if (!profile) return { error: 'Assign a profile to this tab first.' };
  const tabUrl = tab.view.webContents.getURL();
  const lines = [`Profile: ${profile.profile}`];
  lines.push(`Tab URL: ${tabUrl || '(blank)'}`);

  // Report what the profile actually has — makes it obvious when a required field is missing.
  const have = [];
  if (profile.textChestKey) have.push(`TextChest key (${profile.textChestKey.length} chars)`);
  if (profile.smsNumber) have.push(`SMS Number ${profile.smsNumber.replace(/\D/g, '')}`);
  if (profile.passwordUrl) have.push(`password URL ${new URL(profile.passwordUrl).host}`);
  if (profile.otpUrl) have.push(`OTP URL ${new URL(profile.otpUrl).host}`);
  for (const col of (profile.resolvers ?? [])) {
    have.push(`Site:${col.site} → ${col.entries.map((e) => `${e.field}=${e.resolver}`).join(', ')}`);
  }
  lines.push(`Profile has: ${have.length ? have.join('; ') : '(nothing sync-related)'}`);

  if (profile.textChestKey && !profile.smsNumber) {
    lines.push('  ✗ TextChest key is saved but SMS Number is missing — add an SMS Number column.');
  }

  const resolved = await resolveForTab(profile, tabUrl);
  for (const [field, value] of Object.entries(resolved.values)) {
    const masked = String(value).length > 2 ? `${value[0]}${'•'.repeat(Math.max(0, String(value).length - 2))}${value[String(value).length - 1]}` : '••';
    lines.push(`  ✓ ${field}: ${masked}`);
  }
  // Full error text (now carrying the exact URL the TextChest fetch hit).
  for (const err of resolved.errors) lines.push(`  ✗ ${err}`);
  if (profile.passwordUrl) {
    const r = await fetchSyncValue(profile.passwordUrl, profile.passwordAuth, 'password');
    lines.push(r.value ? `  ✓ password URL: got a value` : `  ✗ password URL: ${r.error}`);
  }
  if (profile.otpUrl) {
    const r = await fetchSyncValue(profile.otpUrl, profile.otpAuth, 'otp');
    lines.push(r.value ? `  ✓ OTP URL: ${r.value}` : `  ✗ OTP URL: ${r.error}`);
  }
  if (have.length === 0) lines.push('  (This profile has no resolvers and no sync URLs.)');
  return { report: lines.join('\n') };
}

/**
 * Copies one secret of the tab's profile (password, proxy password, card number / CVV) straight
 * to the clipboard, so the value itself never reaches the window.
 */
// ---------- Encrypted clipboard tokens ----------
//
// Secrets copied from a profile (card number, CVV, expiry, password, proxy password) never go to
// the system clipboard as plaintext. They're AES-256-GCM encrypted with a per-launch session key
// and written as `TF~<base64>`. A paste listener in the stealth preload asks main to decrypt the
// token before inserting it, so pasting into a TabFleet tab shows the real value and pasting into
// any other app (another browser, Notes, Terminal, iMessage) shows unreadable gibberish.

const CLIP_PREFIX = 'TF~';
const clipboardKey = randomBytes(32);

function encryptForClipboard(plain) {
  const text = String(plain ?? '');
  if (!text) return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', clipboardKey, iv);
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return CLIP_PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

function decryptFromClipboardToken(token) {
  if (typeof token !== 'string' || !token.startsWith(CLIP_PREFIX)) return null;
  try {
    const buf = Buffer.from(token.slice(CLIP_PREFIX.length), 'base64');
    if (buf.length < 28) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', clipboardKey, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch {
    return null;
  }
}

async function copySecret(tab, field) {
  const profile = findProfile(tab.profileId);
  if (!profile) return { error: 'Assign a profile to this tab first.' };
  const key = String(field ?? '');
  let value = '';
  if (key === 'password') {
    const resolved = await resolveForTab(profile, tab.view.webContents.getURL());
    value = resolved.values.password
      || (await fetchSyncValue(profile.passwordUrl, profile.passwordAuth, 'password')).value
      || profile.password;
  } else if (key === 'proxyPassword') {
    value = tab.proxy?.password; // the proxy the tab is using
  } else if (/^card\.\d+\.(number|cvv|expiry)$/.test(key)) {
    const [, indexStr, part] = key.split('.');
    const card = profile.cards[Number(indexStr)];
    if (!card) return { error: 'Nothing saved for that field.' };
    value = part === 'expiry'
      ? (card.expMonth && card.expYear ? `${String(card.expMonth).padStart(2, '0')}/${String(card.expYear).slice(-2)}` : '')
      : card[part];
  } else {
    return { error: `Unknown field ${key}.` };
  }
  if (!value) return { error: 'Nothing saved for that field.' };
  clipboard.writeText(encryptForClipboard(value));
  return { ok: true };
}

ipcMain.handle('clipboard:decrypt', (_event, token) => decryptFromClipboardToken(token));
ipcMain.on('clipboard:decrypt-sync', (event, token) => {
  // The paste event handler is synchronous — it needs the plaintext inside the same JS turn to
  // swap it into the field. ipcRenderer.sendSync is the only option; keep this path cheap.
  event.returnValue = decryptFromClipboardToken(token) ?? '';
});

/** Fetches the latest OTP for the tab's profile (via Jancy resolver or the simpler OTP URL) and copies it. */
async function fetchOTPForTab(tab) {
  const profile = findProfile(tab.profileId);
  if (!profile) return { error: 'Assign a profile to this tab first.' };
  const resolved = await resolveForTab(profile, tab.view.webContents.getURL());
  const resolverCode = resolved.values.smscode || resolved.values.emailcode || resolved.values.othercode;
  if (resolverCode) { clipboard.writeText(encryptForClipboard(resolverCode)); return { code: resolverCode }; }
  const urlResult = await fetchSyncValue(profile.otpUrl, profile.otpAuth, 'otp');
  if (urlResult.value) { clipboard.writeText(encryptForClipboard(urlResult.value)); return { code: urlResult.value }; }
  // Nothing worked — stitch together everything we know so the user can act on it.
  const parts = [];
  if (resolved.errors.length) parts.push(...resolved.errors);
  if (profile.otpUrl && urlResult.error) parts.push(`OTP URL: ${urlResult.error}`);
  if (!profile.otpUrl && !(profile.resolvers ?? []).length) {
    return { error: 'This profile has no OTP source. Add a Site:X smscode resolver or an OTP URL in the editor.' };
  }
  if (parts.length === 0) parts.push('No code arrived yet — trigger the SMS again and retry.');
  return { error: `OTP failed. ${parts.join(' · ')}` };
}

async function autofill(tab, cardIndex = 0) {
  const profile = findProfile(tab.profileId);
  if (!profile) return { filled: 0, error: 'Assign a profile to this tab first.' };
  const tabUrl = tab.view.webContents.getURL();
  // Resolve Jancy-style Site:X columns, and (as a fallback) the simpler passwordUrl / otpUrl sync.
  const [resolved, syncPassword, syncOtp] = await Promise.all([
    resolveForTab(profile, tabUrl),
    fetchSyncValue(profile.passwordUrl, profile.passwordAuth, 'password'),
    fetchSyncValue(profile.otpUrl, profile.otpAuth, 'otp'),
  ]);
  // Collect every sync error so autofill can surface them in one place if nothing filled.
  const syncErrors = [...resolved.errors];
  if (profile.passwordUrl && !syncPassword.value && syncPassword.error) syncErrors.push(`password: ${syncPassword.error}`);
  if (profile.otpUrl && !syncOtp.value && syncOtp.error) syncErrors.push(`otp: ${syncOtp.error}`);
  const extras = {
    password: resolved.values.password || syncPassword.value || profile.password,
    otp: resolved.values.smscode || resolved.values.emailcode || resolved.values.othercode || syncOtp.value,
  };
  // Which of the profile's cards the page is showing (e.g. "Visa ending in 4242" above a CVV box
  // that lives in a payment iframe), so the CVV that gets filled belongs to that card.
  if (profile.cards.length > 0) {
    try {
      const shown = await tab.view.webContents.mainFrame.executeJavaScript(buildCardDigitsScript());
      extras.cardHintLast4 = chooseShownCard(shown, profile.cards);
    } catch {}
  }
  const script = buildAutofillScript(profile, profile.cards[Number(cardIndex) || 0] ?? null, extras);
  const totals = { filled: 0, matched: 0, visible: 0, skipped: 0, iframes: 0, unreachableFrames: 0 };
  const frames = [...tab.view.webContents.mainFrame.framesInSubtree];
  for (const frame of frames) {
    try {
      const part = await frame.executeJavaScript(script);
      if (part && typeof part === 'object') {
        totals.filled += Number(part.filled) || 0;
        totals.matched += Number(part.matched) || 0;
        totals.visible += Number(part.visible) || 0;
        totals.skipped += Number(part.skipped) || 0;
        totals.iframes += Number(part.iframes) || 0;
        if (part.cvvCard) totals.cvvCard = part.cvvCard;
        if (part.cvvMismatch) totals.cvvMismatch = part.cvvMismatch;
      } else {
        totals.filled += Number(part) || 0;
      }
    } catch {
      // Frame refused the script — most commonly a cross-origin iframe (payment widgets, OAuth,
      // CAPTCHA). We can't fill those; just note the count so we can tell the user why.
      totals.unreachableFrames++;
    }
  }
  let error = null;
  if (totals.filled === 0) {
    if (syncErrors.length > 0) error = `Sync issues: ${syncErrors.join('; ')}.`;
    else if (totals.unreachableFrames > 0 || totals.iframes > 0) {
      error = `This page's form appears to be inside an embedded frame (${totals.iframes + totals.unreachableFrames} on this page) — payment widgets like Stripe and 3-D-Secure gateways don't allow autofill from outside. Fill it by hand this time.`;
    }
    else if (totals.visible === 0) error = 'No form fields are visible on this page.';
    else if (totals.matched === 0) error = `None of the ${totals.visible} fields matched a profile value — check the fields' names/labels.`;
    else if (totals.skipped > 0) error = `${totals.skipped} field(s) were already filled; nothing new to fill.`;
    else error = 'No profile value was available for the matching fields.';
  } else if (syncErrors.length > 0) {
    error = `Filled ${totals.filled}, but: ${syncErrors.join('; ')}.`;
  }
  if (totals.cvvMismatch && !totals.cvvCard) {
    const note = `The page shows card •••• ${totals.cvvMismatch}, which isn't on this profile, so the CVV was left empty.`;
    error = error ? `${error} ${note}` : `Filled ${totals.filled} field(s). ${note}`;
  }
  return { filled: totals.filled, error, cvvCard: totals.cvvCard ?? null, cvvMismatch: totals.cvvCard ? null : (totals.cvvMismatch ?? null) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Expands an "Add new address/card" collapse OR clicks the primary action button on this page. */
async function submitForm(tab) {
  const script = buildSubmitScript();
  for (const frame of tab.view.webContents.mainFrame.framesInSubtree) {
    try {
      const result = await frame.executeJavaScript(script);
      if (!result || !(result.expanded || result.submitted)) continue;
      return result.expanded ? { expanded: result.expanded } : { submitted: result.submitted };
    } catch {
      // Frame navigated away or not scriptable.
    }
  }
  return { error: 'No primary action button found on this page.' };
}


/** Returns true if the current page has at least one visible OTP / 2FA field. */
async function pageHasOTPField(tab) {
  try {
    const script = `(() => {
      const inputs = [...document.querySelectorAll('input')];
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      return inputs.some((el) => {
        if (!visible(el) || el.disabled || el.readOnly) return false;
        const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
        if (ac === 'one-time-code') return true;
        const t = [el.name, el.id, el.placeholder, el.getAttribute('aria-label') || ''].join(' ').toLowerCase();
        return /\\botp\\b|one.?time|verif(y|ication).?code|sms.?code|\\bauth.?code\\b|two.?factor|2fa|confirmation.?code/.test(t);
      });
    })()`;
    return Boolean(await tab.view.webContents.executeJavaScript(script));
  } catch { return false; }
}

/** Waits until the page is loaded (did-stop-loading) with a safety cap. */
function waitForLoad(tab, ms = 8000) {
  return new Promise((resolve) => {
    const wc = tab.view.webContents;
    const done = () => { wc.off('did-stop-loading', done); resolve(); };
    wc.on('did-stop-loading', done);
    setTimeout(done, ms);
  });
}

/**
 * Multi-step auto login:
 *   1. Navigate to the profile's homepage.
 *   2. For up to 5 steps: wait for page settle → fill → submit. Handles email-then-password-then-
 *      everything-else flows without any site-specific knowledge.
 *   3. On a step that fills 0 fields but shows an OTP field, poll TextChest/OTP source for 30s
 *      and fill the moment a code arrives.
 */
// Hostname → login URL for sites where "the homepage" and "the login page" aren't the same (TM's
// /search has no login form). autoLogin consults this when it needs to pick a destination; the
// profile.url wins when it's set and non-empty.
const KNOWN_LOGIN_URLS = [
  { host: /(^|\.)ticketmaster\.com$/i,  url: 'https://www.ticketmaster.com/member' },
  { host: /(^|\.)ticketmaster\.ca$/i,   url: 'https://www.ticketmaster.ca/member' },
  { host: /(^|\.)ticketmaster\.co\.uk$/i, url: 'https://www.ticketmaster.co.uk/member' },
  { host: /(^|\.)axs\.com$/i,           url: 'https://www.axs.com/customer/account/login' },
  { host: /(^|\.)seatgeek\.com$/i,      url: 'https://seatgeek.com/login' },
  { host: /(^|\.)stubhub\.com$/i,       url: 'https://www.stubhub.com/login' },
];

function loginURLForTab(tab) {
  try {
    const current = tab.view?.webContents?.getURL();
    if (!current) return null;
    const host = new URL(current).hostname;
    for (const entry of KNOWN_LOGIN_URLS) if (entry.host.test(host)) return entry.url;
  } catch {}
  return null;
}

/** Navigate a tab to its sign-in page without filling anything — used by the bulk "Open sign-in"
 * action so a rep can land N accounts on the login screen and manually confirm something before
 * firing Cmd+1 (auto-login) across them. */
function openSignInPage(tab) {
  if (!tabs.includes(tab)) return;
  const profile = findProfile(tab.profileId);
  const target = profile?.url || loginURLForTab(tab);
  if (!target) { notify(`Tab ${tab.slot}: no sign-in URL (set Homepage URL on the profile).`); return; }
  loadInTab(tab, target);
}

async function autoLogin(tab, cardIndex = 0) {
  const profile = findProfile(tab.profileId);
  if (!profile) return { error: 'Assign a profile to this tab first.' };
  // Pick where to go:
  //   1. profile.url (homepage), if set — the user's explicit choice wins.
  //   2. Known login URL for the tab's current host — covers Ticketmaster /search → /member.
  //   3. Fall back to running autofill in-place on whatever is already loaded.
  const target = profile.url || loginURLForTab(tab);
  // Bypass the load scheduler. The scheduler queues background tabs so that a 20-tab session
  // doesn't swamp bandwidth on open, but when the user explicitly fires auto-login on N selected
  // tabs they expect ALL of them to start loading right now, not sit in a queue while autofill
  // runs on the previous page (which was the stale-page / wrong-site problem on bulk Cmd+1).
  if (target) {
    tab.lastURL = target;
    tab.error = null;
    forgetLoads(tab); // drop any queued-but-not-started load for this tab
    try {
      const contents = tab.view?.webContents;
      if (contents && !contents.isDestroyed()) await contents.loadURL(target).catch(() => {});
    } catch {}
  }

  const steps = [];
  for (let step = 0; step < 5; step++) {
    await waitForLoad(tab, step === 0 ? 8000 : 6000);
    await sleep(step === 0 ? 400 : 600); // let late-rendered scripts attach their fields
    const fill = await autofill(tab, cardIndex);
    if (fill.filled === 0) {
      // Nothing matched. Either we're done, or we're parked on an OTP page waiting for the SMS.
      if (step > 0 && await pageHasOTPField(tab)) {
        const otp = await pollForOTP(tab, cardIndex);
        steps.push(otp);
        if (otp.error) break;
      }
      break;
    }
    await sleep(400);
    const submit = await submitForm(tab);
    steps.push({ filled: fill.filled, submitted: submit.submitted, error: submit.error });
    if (submit.error) break;
    await sleep(1200); // let the next page's URL start loading before we re-check
  }

  const totalFilled = steps.reduce((n, s) => n + (s.filled ?? 0), 0);
  const otpStep = steps.find((s) => s.otpFilled);
  const errorStep = steps.find((s) => s.error);
  if (errorStep) return { filled: totalFilled, error: errorStep.error };
  if (steps.length === 0) return { filled: 0, error: 'Nothing to fill — login form may not be on this page.' };
  return {
    filled: totalFilled,
    submitted: steps.map((s) => s.submitted).filter(Boolean).join(' → '),
    otpFilled: otpStep?.otpFilled ?? 0,
    stepCount: steps.length,
  };
}

/** Poll loop for an OTP page — tries autofill (which pulls the latest code) every 3s for 30s. */
async function pollForOTP(tab, cardIndex) {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const otpFill = await autofill(tab, cardIndex);
    if (otpFill.filled > 0) {
      await sleep(300);
      const otpSubmit = await submitForm(tab);
      return { otpFilled: otpFill.filled, submitted: otpSubmit.submitted };
    }
    await sleep(3000);
  }
  return { otpFilled: 0, error: 'Logged in, but no OTP arrived in 30 seconds. Enter it by hand.' };
}

/** Fills the form, waits briefly for the page to react, then clicks the primary action. One click → one page. */
async function autofillAndSubmit(tab, cardIndex = 0) {
  const fillResult = await autofill(tab, cardIndex);
  // If autofill expanded nothing (empty page), submit will try to click "Add new address" instead.
  if (fillResult.filled === 0) {
    const expand = await submitForm(tab);
    if (expand.expanded) return { filled: 0, expanded: expand.expanded, note: `Clicked "${expand.expanded}" — try Autofill & Submit again when the form loads.` };
    return { filled: 0, error: fillResult.error ?? expand.error };
  }
  // Don't press Pay/Continue without a CVV for the card the page is showing.
  if (fillResult.cvvMismatch) return { filled: fillResult.filled, error: fillResult.error };
  // Small pause so sites that validate on blur settle before we click.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const submit = await submitForm(tab);
  if (submit.error) return { filled: fillResult.filled, error: `Filled ${fillResult.filled} field(s), but: ${submit.error}` };
  return { filled: fillResult.filled, submitted: submit.submitted };
}

function setColor(tab, hex) {
  tab.color = TAB_COLORS.some((c) => c.hex === hex) ? hex : null;
  sendState();
}

function setNote(tab, text) {
  tab.note = String(text ?? '').slice(0, 5000);
  sendState();
}

function clearTimer(tab) {
  if (tab.timer) clearTimeout(tab.timer.handle);
  tab.timer = null;
}

function setTimer(tab, minutes) {
  clearTimer(tab);
  tab.timerDone = false;
  const ms = Number(minutes) * 60_000;
  if (ms > 0 && ms <= 24 * 3_600_000) {
    tab.timer = { endsAt: Date.now() + ms, handle: setTimeout(() => fireTimer(tab), ms) };
  }
  sendState();
}

function fireTimer(tab) {
  tab.timer = null;
  if (!tabs.includes(tab)) return;
  tab.timerDone = true;
  if (Notification.isSupported()) {
    const notification = new Notification({
      title: `Tab ${tab.slot}: time to check back`,
      body: tab.view.webContents.getTitle() || tab.lastURL || '',
    });
    notification.on('click', () => {
      if (!win) return;
      win.show();
      if (tabs.includes(tab)) selectTab(tab.id);
    });
    notification.show();
  }
  win?.flashFrame(true);
  sendState();
}

/**
 * Types text into whatever field is focused in the page, as if pasted. If nothing in the page is focused
 * (e.g. the user just clicked something in the Tools panel), re-focuses the most likely candidate: the
 * currently active element in the page, falling back to the first visible, editable field.
 */
async function insertText(tab, text) {
  const contents = tab.view.webContents;
  contents.focus();
  const value = String(text ?? '');
  // Ask the page which field should receive this: the one the user picked (document.activeElement when
  // it is editable) wins; otherwise fall back to the first visible editable field.
  await contents.executeJavaScript(`(() => {
    const editable = (el) => el && (
      (el.tagName === 'INPUT' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'hidden'].includes((el.type || 'text').toLowerCase()))
      || el.tagName === 'TEXTAREA'
      || el.isContentEditable
    );
    const active = document.activeElement;
    if (editable(active)) return;
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const target = [...document.querySelectorAll('input, textarea, [contenteditable]')].find((el) => editable(el) && visible(el));
    target?.focus();
  })()`).catch(() => {});
  contents.insertText(value);
}

function selectedTab() {
  return tabs.find((t) => t.id === selectedId) ?? null;
}

function selectTab(id) {
  selectedId = id;
  const tab = selectedTab();
  if (tab) tab.timerDone = false;
  showSelected();
  // Background tabs stay muted; the active tab unmutes. Toggle only shifts audio, never navigates.
  updateTabAudioMuting();
  if (tab?.queuedLoad) startQueuedLoad(tab);
  sendState();
}

// Mute every tab except the selected one. The user can override per-tab via the Audio toggle, but
// the default behavior is "only the tab I'm looking at is allowed to make noise."
let globalMute = false;
function updateTabAudioMuting() {
  for (const tab of tabs) {
    const contents = tab.view?.webContents;
    if (!contents || contents.isDestroyed()) continue;
    try { contents.setAudioMuted(globalMute || tab.id !== selectedId); } catch {}
  }
}
function toggleGlobalMute() {
  globalMute = !globalMute;
  updateTabAudioMuting();
  notify(globalMute ? 'Muted every tab.' : 'Unmuted (only the active tab plays audio).');
  sendState();
}

function cycleTab(offset) {
  if (tabs.length === 0) return;
  const index = tabs.indexOf(selectedTab());
  selectTab(tabs[(index + offset + tabs.length) % tabs.length].id);
}

// ---------- Tab groups ----------

const TAB_GROUP_COLORS = [
  '#e03131','#f76707','#f59f00','#2f9e44','#0ca678','#1098ad','#339af0',
  '#1c7ed6','#4263eb','#7048e8','#ae3ec9','#d6336c','#f06595','#8d5524',
];

function findGroup(id) { return groups.find((g) => g.id === id) ?? null; }

/** Puts the group members contiguous in the tabs array (keeps the group block ordering stable),
 * so grouping doesn't shuffle every tab. Members already contiguous stay put. */
function compactGroupBlock(groupId, insertAfterTabId = null) {
  const members = tabs.filter((t) => t.groupId === groupId);
  if (members.length === 0) return;
  // Remove members, then re-insert them at the chosen anchor.
  const others = tabs.filter((t) => t.groupId !== groupId);
  let anchor = insertAfterTabId
    ? others.findIndex((t) => t.id === insertAfterTabId)
    : others.findIndex((t) => t.pinned && !t.groupId) + others.filter((t) => t.pinned).length;
  if (anchor < 0) anchor = others.length - 1;
  const result = [...others.slice(0, anchor + 1), ...members, ...others.slice(anchor + 1)];
  tabs = result;
}

function createGroup({ tabIds = [], name = 'Group', color = null } = {}) {
  const id = randomUUID();
  const g = { id, name: String(name || 'Group').slice(0, 40), color: color || TAB_GROUP_COLORS[groups.length % TAB_GROUP_COLORS.length], collapsed: false };
  groups.push(g);
  for (const tid of tabIds) {
    const tab = tabs.find((t) => t.id === tid);
    if (tab) tab.groupId = id;
  }
  compactGroupBlock(id, tabIds[0] ?? null);
  sendState();
  return g;
}

function renameGroup(id, name) {
  const g = findGroup(id);
  if (!g) return;
  g.name = String(name || '').slice(0, 40);
  sendState();
}
function setGroupColor(id, color) {
  const g = findGroup(id);
  if (!g || !color) return;
  g.color = color;
  sendState();
}
function toggleGroupCollapse(id) {
  const g = findGroup(id);
  if (!g) return;
  g.collapsed = !g.collapsed;
  sendState();
}
function ungroupTab(tabId) {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab || !tab.groupId) return;
  const groupId = tab.groupId;
  tab.groupId = null;
  // If the group is now empty, drop it. If not, keep it and compact.
  if (!tabs.some((t) => t.groupId === groupId)) {
    groups = groups.filter((g) => g.id !== groupId);
  }
  sendState();
}
function addTabsToGroup(groupId, tabIds) {
  if (!findGroup(groupId)) return;
  for (const tid of tabIds) {
    const tab = tabs.find((t) => t.id === tid);
    if (tab) tab.groupId = groupId;
  }
  compactGroupBlock(groupId);
  sendState();
}
async function closeGroup(id) {
  const g = findGroup(id);
  if (!g) return;
  const victims = tabs.filter((t) => t.groupId === id);
  if (victims.length > 3 && win) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: [`Close ${victims.length} tabs`, 'Cancel'],
      defaultId: 1, cancelId: 1,
      message: `Close ${victims.length} tabs in "${g.name}"?`,
      detail: 'Pinned tabs are kept. This cannot be undone.',
    });
    if (response !== 0) return;
  }
  for (const tab of victims) if (!tab.pinned) closeTab(tab, { force: false });
  groups = groups.filter((grp) => grp.id !== id);
  sendState();
}

/**
 * Reorders the strip by moving one tab to a new index. The target index is interpreted BEFORE the
 * tab is pulled out, so passing the current index is a no-op and passing length puts it at the end.
 * sendState() refreshes the renderer; the actual WebContentsView stacking is unchanged (only the
 * selected tab is on top), so no view manipulation is needed.
 */
function moveTab(id, toIndex) {
  const from = tabs.findIndex((t) => t.id === id);
  if (from === -1) return;
  const clamped = Math.max(0, Math.min(tabs.length - 1, Number(toIndex) | 0));
  if (clamped === from) return;
  const [tab] = tabs.splice(from, 1);
  // After the splice the array is shorter; if we were moving forward, the target index shifts down.
  const target = clamped > from ? clamped : clamped;
  tabs.splice(Math.min(target, tabs.length), 0, tab);
  sendState();
}

/** Closes a list of tabs. Pinned tabs are skipped (users expect pin to protect against bulk close).
 * Prompts a confirmation when more than 3 tabs would close, since Ctrl+A → × is easy to trigger by
 * accident on a 20-tab session and losing that much state would be hostile. Returns the count. */
async function closeTabs(ids) {
  if (!Array.isArray(ids)) return 0;
  const targets = ids.map((id) => tabs.find((t) => t.id === id)).filter((t) => t && !t.pinned);
  if (targets.length === 0) return 0;
  if (targets.length > 3 && win) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: [`Close ${targets.length} tabs`, 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Close ${targets.length} tabs?`,
      detail: 'Pinned tabs are kept. This cannot be undone.',
    });
    if (response !== 0) return 0;
  }
  for (const tab of targets) closeTab(tab);
  return targets.length;
}

function togglePinTab(tab) {
  if (!tabs.includes(tab)) return;
  tab.pinned = !tab.pinned;
  // Pinned tabs move to the start of the strip so they're always visible even in a wide session.
  if (tab.pinned) {
    const from = tabs.indexOf(tab);
    if (from !== -1) {
      tabs.splice(from, 1);
      // Insert after the last existing pinned tab, so pins stack in the order they were pinned.
      let insertAt = 0;
      while (insertAt < tabs.length && tabs[insertAt].pinned) insertAt++;
      tabs.splice(insertAt, 0, tab);
    }
  }
  sendState();
}

/** Only the selected tab's view is attached; background tabs keep running detached. */
function showSelected() {
  if (!win || win.isDestroyed()) return;
  for (const child of win.contentView.children) {
    if (child !== selectedTab()?.view) win.contentView.removeChildView(child);
  }
  const tab = selectedTab();
  if (mode === 'browser' && tab) {
    win.contentView.addChildView(tab.view);
    layout();
  }
}

function layout() {
  const tab = selectedTab();
  if (!win || !tab) return;
  // Page views are drawn above the window UI, so hide the page while a dialog (Settings…) is open.
  if (tab.view.getVisible() === overlayOpen) tab.view.setVisible(!overlayOpen);
  const [width, height] = win.getContentSize();
  tab.view.setBounds({
    x: insets.left,
    y: insets.top,
    width: Math.max(0, width - insets.right - insets.left),
    height: Math.max(0, height - insets.top),
  });
}

/**
 * Writes the currently-open tabs to a CSV: slot, title, URL, profile, proxy, note, order id.
 * Useful as a shift handover or an audit of what the rep was working on.
 */
async function exportTabsCSV() {
  if (!win) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('documents'), `TabFleet session ${stamp}.csv`),
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (canceled || !filePath) return;
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = ['Slot', 'Title', 'URL', 'Profile', 'Proxy', 'Order', 'Note'];
  const rows = tabs
    .filter((t) => t.partition !== SHEETS_PARTITION)
    .map((t) => {
      const url = t.view?.webContents?.getURL?.() || t.lastURL || '';
      const title = t.view?.webContents?.getTitle?.() || '';
      const profileName = findProfile(t.profileId)?.profile || '';
      const payload = tabOrderPayload.get(t);
      const orderId = payload?.order_id ?? payload?.orderId ?? '';
      return [t.slot, title, url, profileName, proxyLabel(t.proxy) || 'Direct', orderId, (t.note || '').slice(0, 500)];
    });
  const csv = [header, ...rows].map((r) => r.map(esc).join(',')).join('\n');
  await fs.promises.writeFile(filePath, csv);
  notify(`Exported ${rows.length} tab${rows.length === 1 ? '' : 's'} → ${filePath}`);
}

async function screenshot(tab) {
  const image = await tab.view.webContents.capturePage();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('pictures'), `Tab ${tab.slot} ${stamp}.png`),
    filters: [{ name: 'PNG image', extensions: ['png'] }],
  });
  if (!canceled && filePath) await fs.promises.writeFile(filePath, image.toPNG());
}

/** The toolbar's ⋯ menu. Native, so it opens above the page instead of behind it. */
function showMoreMenu() {
  Menu.buildFromTemplate([
    { label: 'Clear This Tab & New IP…', click: () => confirmHardReset() },
    { label: 'Reload Every Tab', click: () => tabs.forEach(reloadTab) },
    { label: 'Save a Screenshot', enabled: Boolean(selectedTab()), click: () => runCommand('screenshot') },
    { label: 'Export Open Tabs to CSV…', enabled: tabs.length > 0, click: () => exportTabsCSV() },
    { type: 'separator' },
    { label: 'Close All Tabs and Start Over', click: () => endSession() },
  ]).popup({ window: win });
}

function showTabMenu(tab, multi) {
  const can = perTabProxies();
  const groupProfiles = profiles.filter(inActiveGroup);
  const profileItems = groupProfiles.slice(0, 40).map((profile) => ({
    label: profile.profile,
    type: 'radio',
    checked: tab.profileId === profile.id,
    click: () => setProfile(tab, profile.id),
  }));
  // When the user right-clicks a tab that's part of a larger multi-select, show the bulk variants
  // at the top of the menu so repetitive per-tab clicks turn into a single action.
  const bulkIds = Array.isArray(multi) && multi.includes(tab.id) && multi.length > 1 ? multi.slice() : null;
  const bulkTabs = bulkIds ? bulkIds.map((id) => tabs.find((t) => t.id === id)).filter(Boolean) : null;
  const bulkSection = bulkTabs && bulkTabs.length > 1 ? [
    { label: `${bulkTabs.length} tabs selected`, enabled: false },
    { label: `Group ${bulkTabs.length} tabs…`, click: () => createGroup({ tabIds: bulkIds, name: 'Group' }) },
    { label: `Clear cookies on ${bulkTabs.length}`, click: async () => {
      const n = await clearCookiesOnTabs(bulkIds);
      notify(`Cleared cookies on ${n} tab${n === 1 ? '' : 's'}.`);
    } },
    { label: `Burn IP on ${bulkTabs.length}`, enabled: can, click: () => bulkTabs.forEach((t) => burnIP(t)) },
    { label: `Clear & New IP on ${bulkTabs.length}`, click: () => bulkTabs.forEach((t) => clearThisTab(t)) },
    { label: `Open sign-in page on ${bulkTabs.length}`, click: () => bulkTabs.forEach((t) => openSignInPage(t)) },
    { label: `Auto-Login on ${bulkTabs.length}`, enabled: bulkTabs.every((t) => t.profileId), click: () => bulkTabs.forEach((t) => autoLogin(t)) },
    { label: `Go Home on ${bulkTabs.length}`, click: () => bulkTabs.forEach((t) => runCommand('home', t.id)) },
    { label: `Close ${bulkTabs.length} tabs`, click: () => closeTabs(bulkIds) },
    { type: 'separator' },
  ] : [];
  Menu.buildFromTemplate([
    ...bulkSection,
    { label: tab.pinned ? 'Unpin Tab' : 'Pin Tab', click: () => togglePinTab(tab) },
    { label: tab.watchPattern ? `Watching: ${tab.watchPattern.slice(0, 40)} — change…` : 'Watch for URL…', click: () => promptWatchPattern(tab) },
    {
      label: 'Group',
      submenu: [
        { label: 'New group with this tab', click: () => createGroup({ tabIds: [tab.id], name: 'Group' }) },
        ...groups.map((g) => ({
          label: g.name, type: 'radio', checked: tab.groupId === g.id,
          click: () => addTabsToGroup(g.id, [tab.id]),
        })),
        { type: 'separator' },
        { label: 'Remove from group', enabled: Boolean(tab.groupId), click: () => ungroupTab(tab.id) },
      ],
    },
    { label: 'Duplicate Tab', click: () => duplicateTab(tab) },
    {
      label: hasActiveGroup() ? `Set Profile (${groupName(settings.activeGroup)})` : 'Set Profile',
      enabled: groupProfiles.length > 0,
      submenu: [
        { label: 'None', type: 'radio', checked: !tab.profileId, click: () => setProfile(tab, null) },
        ...profileItems,
        ...(groupProfiles.length > 40 ? [{ label: 'More in the Tools panel…', enabled: false }] : []),
      ],
    },
    { label: 'Autofill From Profile', enabled: Boolean(tab.profileId), click: () => autofill(tab) },
    { label: 'Clear Profile Cookies', enabled: Boolean(tab.profileId), click: () => clearProfileCookies(tab) },
    { type: 'separator' },
    { label: 'Burn IP and Reload', enabled: can, click: () => burnIP(tab) },
    { label: tab.proxy ? 'Switch to Local IP' : 'Switch to Proxy', enabled: can, click: () => toggleProxy(tab) },
    {
      label: 'Region',
      enabled: can && pool.regions.length > 0,
      submenu: pool.regions.map((region) => ({
        label: region.toUpperCase(), type: 'radio', checked: tab.region === region, click: () => setRegion(tab, region),
      })),
    },
    { type: 'separator' },
    {
      label: 'Color',
      submenu: [
        { label: 'None', type: 'radio', checked: !tab.color, click: () => setColor(tab, null) },
        ...TAB_COLORS.map((c) => ({ label: c.name, type: 'radio', checked: tab.color === c.hex, click: () => setColor(tab, c.hex) })),
      ],
    },
    {
      label: 'Timer',
      submenu: [
        ...TIMER_PRESETS.map((minutes) => ({ label: `${minutes} min`, click: () => setTimer(tab, minutes) })),
        { type: 'separator' },
        { label: 'Clear Timer', enabled: Boolean(tab.timer), click: () => setTimer(tab, 0) },
      ],
    },
    { type: 'separator' },
    { label: 'Close Tab', click: () => closeTab(tab, { force: true }) },
  ]).popup({ window: win });
}

// ---------- UI bridge ----------

// Busy pages (single-page apps, queues) fire navigation and title events many times a second in every
// tab. Each state message re-renders the window, so they're coalesced to at most one every
// STATE_INTERVAL_MS and skipped entirely when nothing visible changed.
const STATE_INTERVAL_MS = 100;
let stateTimer = null;
let lastStateAt = 0;
let lastStateJSON = '';

function sendState() {
  if (stateTimer) return;
  const wait = Math.max(0, lastStateAt + STATE_INTERVAL_MS - Date.now());
  stateTimer = setTimeout(flushState, wait);
}

function flushState() {
  stateTimer = null;
  lastStateAt = Date.now();
  if (!win || win.isDestroyed()) return;
  const next = snapshot();
  const json = JSON.stringify(next);
  if (json !== lastStateJSON) {
    saveSessionState();
    lastStateJSON = json;
    win.webContents.send('state', next);
  }
  updateMenu();
}

function snapshot() {
  const poolStats = pool?.coolStats?.() ?? null;
  return {
    mode,
    groups: groupList(),
    clockZone,
    activeGroup: hasActiveGroup() ? settings.activeGroup : null,
    recording: recordingActive,
    recordedCount: recordedActions.length,
    perTabProxies: perTabProxies(),
    poolStats, // { total, cool, entries } for list pools; null otherwise
    tabGroups: groups.map((g) => ({ id: g.id, name: g.name, color: g.color, collapsed: g.collapsed })),

    regions: pool?.regions ?? [],
    selectedId,
    tabs: tabs.map((tab) => {
      const contents = tab.view.webContents;
      const url = contents.getURL();
      const profile = findProfile(tab.profileId);
      const onSheet = isSheetsURL(url);
      let host = '';
      try {
        host = new URL(url || tab.lastURL).host;
      } catch {}
      return {
        id: tab.id,
        slot: tab.slot,
        title: contents.getTitle() || (tab.queuedLoad ? 'Waiting to load…' : host || 'New Tab'),
        url: url || tab.lastURL || '',
        // Ads and trackers keep frames loading long after the page is usable; spin for the page only.
        loading: contents.isLoadingMainFrame(),
        queued: Boolean(tab.queuedLoad),
        canGoBack: contents.navigationHistory.canGoBack(),
        canGoForward: contents.navigationHistory.canGoForward(),
        proxy: proxyLabel(tab.proxy),
        proxyParts: tab.proxy
          ? { host: tab.proxy.host, port: tab.proxy.port, username: tab.proxy.username ?? '', hasPassword: Boolean(tab.proxy.password) }
          : null,
        // For account tabs: 'account' | 'backup' | 'pinned' | 'direct', plus "backup n of m".
        proxyKind: profileSessionFor(tab.partition)?.proxyInfo?.kind ?? null,
        timezone: tab.timezone ?? null,
        region: tab.region,
        error: tab.error,
        color: tab.color,
        note: tab.note,
        timerEndsAt: tab.timer?.endsAt ?? null,
        timerDone: tab.timerDone,
        profileId: profile?.id ?? null,
        profileName: profile?.profile ?? null,
        favicon: tab.favicon ?? null,
        muted: contents.isAudioMuted?.() ?? false,
        pinned: Boolean(tab.pinned),
        attention: Boolean(tab.attention),
        watchPattern: tab.watchPattern || null,
        groupId: tab.groupId || null,
        // When the tab is tracking an invoiced order (opened via Search or the auto-watcher), the
        // order's human-readable number is surfaced so the strip can show a ◆#123 chip and the
        // user never loses the mapping between tab and order.
        orderId: tabOrderPayload.get(tab)?.order_id ?? tabOrderPayload.get(tab)?.orderId ?? null,
        onSheet,
      };
    }),
  };
}

const commands = {
  moreMenu: () => showMoreMenu(),
  hardReset: () => confirmHardReset(),
  // Opens the event's Ticketmaster search in a new tab.
  searchEvent: (_tab, event) => {
    const url = sync.eventSearchURL(event);
    if (!url) return;
    // The window asks for the profile first; the tab opens straight in that profile's session.
    const tab = createTab({ url, profileId: event?.profileId ?? null });
    setNote(tab, sync.eventSearchNote(event));
    // Keep the order details on the tab so the seat-matcher script can read them once the user has
    // picked the correct event from the search results and reached the event page itself.
    if (event) tabOrderPayload.set(tab, event);
    // Promote the order from "new" to "working" so the Orders panel can filter it out of the queue.
    if (event?.id || event?.orderId) ensureOrderStatusStore().touch(event.id ?? event.orderId);
  },
  newTab: (_tab, options) => {
    // Three entry points: explicit profile id (favorite chip), smart assignment (plain +), or no
    // preference (shift+click +). Picker only opens when no profile was found and some exist.
    const explicitId = options?.profileId;
    const smart = options?.smart !== false && !explicitId;
    let chosenProfileId = explicitId || null;
    if (smart && !chosenProfileId) {
      const groupProfiles = profiles.filter(inActiveGroup);
      if (groupProfiles.length > 0) {
        const inUse = new Set(tabs.map((t) => t.profileId).filter(Boolean));
        const free = groupProfiles.find((p) => !inUse.has(p.id));
        if (free) chosenProfileId = free.id;
      }
    }
    const tab = createTab(chosenProfileId ? { profileId: chosenProfileId } : {});
    if (!tab.profileId && profiles.length > 0 && !explicitId) win?.webContents.send('toggle-panel', 'pick-profile');
  },
  assignProfiles: (_tab, options) => assignProfiles(options),
  refreshAll: () => tabs.forEach(reloadTab),
  burnAll: () => burnAll(),
  nextTab: () => cycleTab(1),
  previousTab: () => cycleTab(-1),
  endSession: () => endSession(),
  copy: (_tab, text) => clipboard.writeText(String(text ?? '')),
  selectTab: (tab) => selectTab(tab.id),
  closeTab: (tab) => closeTab(tab),
  moveTab: (tab, toIndex) => moveTab(tab.id, toIndex),
  closeTabs: (_tab, ids) => closeTabs(Array.isArray(ids) ? ids : []),
  pinTab: (tab) => togglePinTab(tab),
  // Tab groups — most take a group id (not a tab) in `arg`.
  createGroup: (_tab, arg) => createGroup(arg ?? {}),
  renameGroup: (_tab, arg) => renameGroup(arg?.id, arg?.name),
  setGroupColor: (_tab, arg) => setGroupColor(arg?.id, arg?.color),
  toggleGroupCollapse: (_tab, id) => toggleGroupCollapse(id),
  ungroupTab: (tab) => ungroupTab(tab.id),
  addTabsToGroup: (_tab, arg) => addTabsToGroup(arg?.groupId, arg?.tabIds ?? []),
  closeGroup: (_tab, id) => closeGroup(id),
  setWatchPattern: (tab, pattern) => {
    tab.watchPattern = typeof pattern === 'string' && pattern.trim() ? pattern.trim() : null;
    tab.attention = false;
    sendState();
  },
  clearAttention: (tab) => { tab.attention = false; sendState(); },
  duplicate: (tab) => duplicateTab(tab),
  setProfile: (tab, arg) => (arg && typeof arg === 'object'
    ? setProfile(tab, arg.profileId ?? null, { url: typeof arg.url === 'string' ? arg.url : null })
    : setProfile(tab, arg)),
  clearProfileCookies: (tab) => clearProfileCookies(tab),
  clearCookiesOn: async (_tab, ids) => {
    const n = await clearCookiesOnTabs(Array.isArray(ids) ? ids : []);
    notify(`Cleared cookies on ${n} tab${n === 1 ? '' : 's'}.`);
  },
  openSignIn: (tab) => openSignInPage(tab),
  autofill: (tab, cardIndex) => autofill(tab, cardIndex),
  autofillSubmit: (tab, cardIndex) => autofillAndSubmit(tab, cardIndex),
  autoLogin: (tab, cardIndex) => autoLogin(tab, cardIndex),
  submitForm: (tab) => submitForm(tab),
  fetchOTP: (tab) => fetchOTPForTab(tab),
  copySecret: (tab, field) => copySecret(tab, field),
  diagnoseSync: (tab) => diagnoseSync(tab),
  burn: (tab) => burnIP(tab),
  toggleProxy: (tab) => toggleProxy(tab),
  setRegion: (tab, region) => setRegion(tab, region),
  setColor: (tab, hex) => setColor(tab, hex),
  setNote: (tab, text) => setNote(tab, text),
  setTimer: (tab, minutes) => setTimer(tab, minutes),
  insertText: (tab, text) => insertText(tab, text),
  tabMenu: (tab, multi) => showTabMenu(tab, Array.isArray(multi) ? multi : null),
  reload: (tab) => reloadTab(tab),
  // Home: the tab's profile homepage when it has one, otherwise the launch screen's start page.
  home: (tab) => loadInTab(tab, findProfile(tab.profileId)?.url || config.startURL),
  stop: (tab) => tab.view.webContents.stop(),
  back: (tab) => tab.view.webContents.navigationHistory.goBack(),
  forward: (tab) => tab.view.webContents.navigationHistory.goForward(),
  navigate: (tab, input) => loadInTab(tab, input),
  screenshot: (tab) => screenshot(tab).catch((error) => dialog.showErrorBox('Screenshot failed', error.message)),
};

const TABLESS = new Set(['hardReset', 'searchEvent', 'moreMenu', 'newTab', 'assignProfiles', 'refreshAll', 'burnAll', 'nextTab', 'previousTab', 'endSession', 'closeTabs', 'clearCookiesOn']);

/** Runs a command against `tabId`, or the selected tab when omitted. */
function runCommand(name, tabId, arg) {
  const command = commands[name];
  if (!command || mode !== 'browser') return;
  if (TABLESS.has(name)) return command(null, arg);
  const tab = tabs.find((t) => t.id === tabId) ?? selectedTab();
  if (tab) return command(tab, arg);
}

ipcMain.handle('get-initial', () => ({ config, state: snapshot(), palette: TAB_COLORS, timerPresets: TIMER_PRESETS }));
ipcMain.handle('validate', (_event, raw) => validateConfig(normalizeConfig(raw)));
ipcMain.handle('launch', async (_event, raw) => {
  const { group: _group, ...settingsForm } = raw ?? {};
  const next = normalizeConfig(settingsForm);
  const error = validateConfig(next);
  if (error) return error;
  // With several groups the user picks one for this session; it can't change until TabFleet restarts.
  const groups = groupList();
  if (groups.length > 1) {
    const key = typeof raw?.group === 'string' ? raw.group : null;
    if (!groups.some((g) => g.key === key)) return 'Choose the group of accounts to work in.';
    setActiveGroup(key);
  }
  try {
    await startSession(next);
    return null;
  } catch (startError) {
    return startError.message || 'Could not load the proxy list.';
  }
});
/**
 * Scan every proxy in the saved pool against ipquery.io, remove the flagged ones (datacenter, VPN,
 * TOR, known-proxy, risk ≥ 70, or unreachable) from the current running pool AND from the saved
 * config so the start screen doesn't offer them again. Returns the full result set so the UI can
 * show per-proxy reasons.
 *
 * Only works on a 'list' pool: rotating gateways don't have individual exit IPs to score. During
 * the scan every pinned-proxy that gets removed is cleared on each profile so the next launch
 * repins to a surviving one.
 */
async function scanProxyPool() {
  if (!pool?.enabled) return { error: 'Start a browsing session with a proxy list first.' };
  if (pool.kind !== 'list' || pool.list.length === 0) {
    return { error: 'Reputation checks only work on list-based proxy pools, not rotating gateways.' };
  }
  const original = pool.list.slice();
  notify(`Checking ${original.length} proxies against ipquery.io…`);
  const results = await checkProxyReputations(original, ({ done, total }) => {
    if (done === total || done % 5 === 0) win?.webContents.send('notice', `Checked ${done}/${total} proxies…`);
  });
  const flaggedKeys = new Set(results.filter((r) => r.flagged).map((r) => proxyKey(r.proxy)));
  if (flaggedKeys.size === 0) {
    notify(`All ${original.length} proxies passed the reputation check.`);
    return { total: original.length, removed: 0, results };
  }

  // Rebuild config.proxyList text with flagged lines removed. parseProxyList ignores blank/invalid
  // lines, so rebuild by filtering the parsed proxies and reserializing — the user's comments on
  // the saved text are lost, but the surviving endpoints are preserved exactly.
  const survivingProxies = parseProxyList(config.proxyList).filter((p) => !flaggedKeys.has(proxyKey(p)));
  const serialize = (p) => {
    const auth = p.username ? `${p.username}:${p.password ?? ''}@` : '';
    const scheme = p.kind === 'socks5' ? 'socks5://' : '';
    const region = p.region ? ` ${p.region}` : '';
    return `${scheme}${auth}${p.host}:${p.port}${region}`.trim();
  };
  config.proxyList = survivingProxies.map(serialize).join('\n');
  writeData('config.json', config);

  // Rebuild the running pool from the cleaned list so New IP / assignment stops handing out dead proxies.
  pool = createPool({ ...config, proxyList: config.proxyList });

  // Any profile pinned to a flagged proxy should be un-pinned so it picks a clean one next time.
  let unpinnedCount = 0;
  for (const profile of profiles) {
    if (profile.pinnedProxy && flaggedKeys.has(proxyKey(profile.pinnedProxy.proxy))) {
      profile.pinnedProxy = null;
      unpinnedCount++;
    }
  }
  if (unpinnedCount > 0) saveProfiles();

  notify(`Removed ${flaggedKeys.size} flagged proxies. ${original.length - flaggedKeys.size} remain.`);
  return { total: original.length, removed: flaggedKeys.size, unpinned: unpinnedCount, results };
}

/**
 * Scan the proxy list text the user typed on the start screen (before launching a session). Returns
 * the cleaned text so the renderer can swap it into the textarea, plus the per-proxy results so the
 * UI can show flags. Pure function — doesn't touch config.json, profiles, or the running pool.
 */
async function scanProxyPoolText(text) {
  const proxies = parseProxyList(String(text ?? ''));
  if (proxies.length === 0) return { error: 'Paste at least one proxy before checking.' };
  const results = await checkProxyReputations(proxies, ({ done, total }) => {
    if (done === total || done % 5 === 0) win?.webContents.send('notice', `Checked ${done}/${total} proxies…`);
  });
  const flaggedKeys = new Set(results.filter((r) => r.flagged).map((r) => proxyKey(r.proxy)));
  const survivors = proxies.filter((p) => !flaggedKeys.has(proxyKey(p)));
  const serialize = (p) => {
    const auth = p.username ? `${p.username}:${p.password ?? ''}@` : '';
    const scheme = p.kind === 'socks5' ? 'socks5://' : '';
    const region = p.region ? ` ${p.region}` : '';
    return `${scheme}${auth}${p.host}:${p.port}${region}`.trim();
  };
  return {
    total: proxies.length,
    removed: flaggedKeys.size,
    cleanedText: survivors.map(serialize).join('\n'),
    results,
  };
}

/**
 * Developer helper: build a fake order record from UI input. Shared between the two test paths
 * (inject into current tab vs. open the full search flow in a new tab).
 */
function fakeOrderFromTestPayload(payload) {
  return {
    event_name: payload?.eventName ?? '',
    occurs_at: payload?.occursAt ?? '',
    section: payload?.section ?? '',
    row: payload?.row ?? '',
    low_seat: payload?.lowSeat ?? null,
    high_seat: payload?.highSeat ?? payload?.lowSeat ?? null,
    quantity: payload?.quantity ?? null,
    order_id: `TEST-${Date.now()}`,
    autoClick: Boolean(payload?.autoClick),
  };
}

async function testSeatMatchOnSelectedTab(payload) {
  const tab = selectedTab();
  if (!tab) return { error: 'Open a tab first.' };
  const contents = tab.view?.webContents;
  if (!contents || contents.isDestroyed()) return { error: 'The tab is not ready.' };
  const url = contents.getURL();
  if (!/ticketmaster\./i.test(url)) {
    return { error: 'Open a ticketmaster.com page in this tab first, then try again.' };
  }
  const fakeOrder = fakeOrderFromTestPayload(payload);
  tabOrderPayload.set(tab, fakeOrder);
  try {
    await contents.executeJavaScript(buildSeatMatchScript(fakeOrder), true);
    return { ok: true };
  } catch (error) {
    return { error: error?.message || 'Script injection failed.' };
  }
}

async function openSeatMatchTestFlow(payload) {
  if (!payload?.eventName) return { error: 'Enter an event name.' };
  const fakeOrder = fakeOrderFromTestPayload(payload);
  const event = orderToEvent(fakeOrder);
  const url = sync.eventSearchURL(event);
  if (!url) return { error: 'Could not build a Ticketmaster search URL (event name required).' };
  const tab = createTab({ url, select: true });
  setNote(tab, sync.eventSearchNote(event));
  tabOrderPayload.set(tab, fakeOrder);
  return { ok: true, tabId: tab.id };
}

ipcMain.handle('seats:test', (_event, payload) => testSeatMatchOnSelectedTab(payload ?? {}));
ipcMain.handle('seats:test-flow', (_event, payload) => openSeatMatchTestFlow(payload ?? {}));
ipcMain.handle('recorder:start', () => { startRecording(); return { ok: true }; });
ipcMain.handle('recorder:stop', (_event, options) => stopRecording(options ?? {}));
ipcMain.handle('recorder:status', () => ({ active: recordingActive, count: recordedActions.length }));

// Playbook CRUD + run
// Re-save the most recent raw recording as a named playbook. The record-stop path writes a
// recording-<timestamp>.json file first (unconditionally so nothing is ever lost); this handler
// picks the newest such file, re-tags variables against the live order, and saves as a playbook.
ipcMain.handle('playbooks:save-from-last-recording', (_event, { name, orderContext } = {}) => {
  if (!name) return { error: 'Give the playbook a name.' };
  try {
    const dir = app.getPath('userData');
    const files = fs.readdirSync(dir)
      .filter((f) => /^recording-\d+\.json$/.test(f))
      .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return { error: 'No recent recording found.' };
    const raw = JSON.parse(fs.readFileSync(path.join(dir, files[0].f), 'utf8'));
    const actions = playbooksStore.autoBindVariables(raw.actions || [], { order: orderContext || null });
    const hostPatterns = Array.from(new Set((actions || []).map((a) => {
      try { return new URL(a.url || '').hostname; } catch { return null; }
    }).filter(Boolean))).slice(0, 5);
    const pb = playbooksStore.savePlaybook(dir, { name, hostPatterns, actions });
    return { ok: true, playbook: pb };
  } catch (error) {
    return { error: error?.message || 'Could not save playbook.' };
  }
});

ipcMain.handle('playbooks:list', () => playbooksStore.listPlaybooks(app.getPath('userData')));
ipcMain.handle('playbooks:rename', (_event, { id, name } = {}) => {
  if (!id || !name) return { error: 'Give both an id and a name.' };
  try {
    const dir = app.getPath('userData');
    const existing = playbooksStore.readPlaybook(dir, id);
    if (!existing) return { error: 'Playbook not found.' };
    playbooksStore.deletePlaybook(dir, id);
    const saved = playbooksStore.savePlaybook(dir, { ...existing, name });
    return { ok: true, playbook: saved };
  } catch (error) { return { error: error?.message || 'Could not rename.' }; }
});
ipcMain.handle('playbooks:read', (_event, id) => playbooksStore.readPlaybook(app.getPath('userData'), id));
ipcMain.handle('playbooks:delete', (_event, id) => playbooksStore.deletePlaybook(app.getPath('userData'), id));
ipcMain.handle('playbooks:run', (_event, { tabId, playbookId, order } = {}) => runPlaybookOnTab(tabId, playbookId, order));
ipcMain.handle('playbooks:run-on-url', (_event, { url, playbookId, order, profileId } = {}) => runPlaybookOnURL(url, playbookId, order, { profileId }));
ipcMain.handle('playbooks:stop', (_event, runId) => { stopPlaybook(runId); return { ok: true }; });
ipcMain.handle('proxies:scan', () => scanProxyPool());
ipcMain.handle('proxies:scan-text', (_event, text) => scanProxyPoolText(text));
ipcMain.handle('snippets:get', () => loadSnippets());
ipcMain.handle('snippets:save', (_event, list) => saveSnippets(Array.isArray(list) ? list : []));
ipcMain.on('command', (_event, name, tabId, arg) => runCommand(name, tabId, arg));
ipcMain.handle('invoke', (_event, name, tabId, arg) => runCommand(name, tabId, arg));
ipcMain.handle('profiles:list', () => profiles.map(publicProfile));
ipcMain.handle('profiles:import-file', () => importProfilesFile());
ipcMain.handle('profiles:export-file', async () => {
  if (profiles.length === 0) return { error: 'No profiles to export yet.' };
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export profiles',
    defaultPath: `tabfleet-profiles-${new Date().toISOString().slice(0, 10)}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (canceled || !filePath) return { canceled: true };
  await fs.promises.writeFile(filePath, profilesToCSV(profiles), 'utf8');
  return { exported: profiles.length, path: filePath };
});
ipcMain.handle('profiles:import-text', (_event, text) => importProfilesText(String(text ?? '')));
ipcMain.handle('profiles:delete', (_event, ids) => deleteProfiles(Array.isArray(ids) ? ids : null));
ipcMain.handle('profiles:save', (_event, input) => saveProfileFromEditor(input));
ipcMain.handle('profiles:open-sheet', (_event, url) => openSheetTab(url));
ipcMain.handle('profiles:import-sheet', (_event, url) => importFromSheetURL(url));
ipcMain.handle('groups:switch', (_event, input) => switchGroup(input));
ipcMain.handle('groups:restart', () => restartForGroup());
ipcMain.handle('groups:rename', (_event, input) => renameGroup(input));
ipcMain.handle('sync:get-settings', () => syncSettingsInfo());
ipcMain.handle('sync:save-settings', (_event, input) => saveSyncCredentials(input));
ipcMain.handle('sync:test', async () => {
  const result = await listSyncOrders({ limit: 1 });
  return result.error ? { error: result.error } : { ok: true, count: result.count };
});
ipcMain.handle('orders:list', (_event, params) => listSyncOrders(params ?? {}));
ipcMain.handle('orders:set-status', (_event, { id, status } = {}) => markOrderStatus(id, status));

// Account health — on-demand background check that returns {profileId, status, reason} per account.
// Runs each profile's probe through its own session so cookies and proxy routing match the real tab
// the user would open. Results are cached so the renderer can render dots without re-querying.
let accountHealthCache = { at: 0, results: [] };
async function runAccountHealthCheck() {
  const sessionFor = (profile) => {
    const entry = profileSessions.get(profile.id);
    const partition = entry?.partition ?? profilePartition(profile.id);
    try { return session.fromPartition(partition); } catch { return null; }
  };
  const groupProfiles = profiles.filter(inActiveGroup);
  const results = await checkAllAccounts(groupProfiles, sessionFor);
  accountHealthCache = { at: Date.now(), results };
  win?.webContents.send('account-health-changed', accountHealthCache);
  return accountHealthCache;
}
ipcMain.handle('accounts:health-check', () => runAccountHealthCheck());
ipcMain.handle('accounts:health', () => accountHealthCache);

// ---------- Shortcut customization ----------
//
// Users can rebind any action in shortcuts.js. Overrides are stored as a plain {id: accelerator}
// map in data/shortcuts.json. The merged map is read when building the application menu and sent
// to the renderer so in-window handlers can match keystrokes against the current bindings.

let shortcutOverrides = loadShortcutOverrides();
function loadShortcutOverrides() {
  try {
    const parsed = JSON.parse(fs.readFileSync(dataPath('shortcuts.json'), 'utf8'));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}
  return {};
}
function currentAccelerators() { return resolveAccelerators(shortcutOverrides); }
function saveShortcutOverrides(next) {
  shortcutOverrides = { ...next };
  writeData('shortcuts.json', shortcutOverrides);
  // Rebuild the menu so the new accelerators take effect without a restart.
  updateMenu();
  win?.webContents.send('shortcuts-changed', { accelerators: currentAccelerators() });
}

ipcMain.handle('shortcuts:get', () => ({ actions: ACTIONS, defaults: DEFAULT_BY_ID, overrides: shortcutOverrides, current: currentAccelerators() }));
ipcMain.handle('shortcuts:set', (_event, { id, accelerator }) => {
  if (!(id in DEFAULT_BY_ID)) return { error: 'Unknown action.' };
  const next = { ...shortcutOverrides };
  if (!accelerator || accelerator === DEFAULT_BY_ID[id]) delete next[id];
  else next[id] = String(accelerator);
  saveShortcutOverrides(next);
  return { ok: true, current: currentAccelerators() };
});
ipcMain.handle('shortcuts:reset', () => { saveShortcutOverrides({}); return { ok: true, current: currentAccelerators() }; });
ipcMain.on('overlay', (_event, open) => {
  overlayOpen = Boolean(open);
  layout();
});
ipcMain.on('layout-insets', (_event, next) => {
  insets = {
    top: Math.max(0, Math.round(Number(next?.top) || 0)),
    right: Math.max(0, Math.round(Number(next?.right) || 0)),
    left: Math.max(0, Math.round(Number(next?.left) || 0)),
  };
  layout();
});


// Proxy credentials can't go in Chromium's proxy rules, so they're answered here.
app.on('login', (event, webContents, _details, authInfo, callback) => {
  if (!authInfo.isProxy) return;
  const tab = webContents ? tabs.find((t) => t.view.webContents === webContents) : null;
  const proxy = tab ? tab.proxy : sharedProxy;
  if (!proxy?.username) return;
  if (tab && ++tab.authAttempts > MAX_PROXY_AUTH_ATTEMPTS) {
    // The proxy keeps rejecting our credentials. Cool it down so the next pick skips it and we
    // don't loop on the same dead IP across tabs.
    if (pool?.markBad && tab.proxy) pool.markBad(tab.proxy, 'auth rejected');
    return;
  }
  event.preventDefault();
  callback(proxy.username, proxy.password ?? '');
});

// ---------- Window & menu ----------

function openSettings() {
  if (!win) return;
  win.webContents.focus();
  win.webContents.send('open-settings');
}

function checkForUpdatesFromMenu() {
  openSettings();
  checkForUpdates({ manual: true });
}

let menuKey = '';

/** Rebuilds the application menu only when something it shows changed (rebuilding it is slow on Windows). */
function updateMenu() {
  const inBrowser = mode === 'browser';
  const can = perTabProxies();
  // Include the user's accelerator overrides in the cache key so rebinding immediately rebuilds.
  const A = currentAccelerators();
  const key = `${inBrowser}|${can}|${Boolean(selectedTab()?.proxy)}|${JSON.stringify(shortcutOverrides)}`;
  if (key === menuKey) return;
  menuKey = key;
  const send = (name) => () => runCommand(name);
  const template = [
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: openSettings },
        { label: 'Check for Updates…', click: checkForUpdatesFromMenu },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: A.newTab, enabled: inBrowser, click: send('newTab') },
        { label: 'Duplicate Tab', accelerator: A.duplicate, enabled: inBrowser, click: send('duplicate') },
        { label: 'Close Tab', accelerator: A.closeTab, enabled: inBrowser, click: send('closeTab') },
        { type: 'separator' },
        { label: 'Screenshot', accelerator: 'CmdOrCtrl+Shift+S', enabled: inBrowser, click: send('screenshot') },
        { type: 'separator' },
        { label: 'End Session', accelerator: 'CmdOrCtrl+Shift+E', enabled: inBrowser, click: send('endSession') },
        ...(process.platform === 'darwin' ? [] : [
          { type: 'separator' },
          { label: 'Settings…', accelerator: 'Ctrl+,', click: openSettings },
          { label: 'Check for Updates…', click: checkForUpdatesFromMenu },
        ]),
        process.platform === 'darwin' ? { role: 'close', accelerator: 'CmdOrCtrl+Shift+W' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: A.reload, enabled: inBrowser, click: send('reload') },
        { label: 'Home', accelerator: process.platform === 'darwin' ? 'Cmd+Shift+H' : 'Alt+Home', enabled: inBrowser, click: send('home') },
        { label: 'Refresh All Tabs', accelerator: 'CmdOrCtrl+Shift+R', enabled: inBrowser, click: send('refreshAll') },
        { type: 'separator' },
        {
          label: 'Open Location',
          accelerator: A.focusAddress,
          enabled: inBrowser,
          click: () => {
            win.webContents.focus();
            win.webContents.send('focus-address');
          },
        },
        {
          label: 'Jump to Tab…',
          accelerator: A.palette,
          enabled: inBrowser,
          click: () => { win?.webContents.focus(); win?.webContents.send('open-palette'); },
        },
        {
          label: 'Tools Panel',
          accelerator: A.toolsPanel,
          enabled: inBrowser,
          click: () => win.webContents.send('toggle-panel'),
        },
        { label: 'Back', accelerator: process.platform === 'darwin' ? 'Cmd+[' : 'Alt+Left', enabled: inBrowser, click: send('back') },
        { label: 'Forward', accelerator: process.platform === 'darwin' ? 'Cmd+]' : 'Alt+Right', enabled: inBrowser, click: send('forward') },
        { type: 'separator' },
        { label: 'Next Tab', accelerator: A.nextTab, enabled: inBrowser, click: send('nextTab') },
        { label: 'Previous Tab', accelerator: A.previousTab, enabled: inBrowser, click: send('previousTab') },
        { type: 'separator' },
        // Numeric jump: ⌘⇧1..9 → tab in slot N (Chrome-like, but Shift so we don't clash with the
        // existing ⌘1/⌘2/⌘3 bulk shortcuts for login/fill/home).
        ...[1,2,3,4,5,6,7,8,9].map((n) => ({
          label: `Jump to Tab ${n}`,
          accelerator: `CmdOrCtrl+Shift+${n}`,
          enabled: inBrowser,
          visible: false,
          click: () => { const t = tabs.find((x) => x.slot === n); if (t) selectTab(t.id); },
        })),
        {
          label: 'Reopen Last Closed Tab',
          accelerator: A.reopenClosed,
          enabled: inBrowser,
          click: () => reopenLastClosedTab(),
        },
        { type: 'separator' },
        // Dev-only entries. In a packaged release both are omitted entirely (not just hidden),
        // so neither the menu item nor its accelerator surface for end users.
        ...(app.isPackaged ? [] : [
          {
            label: 'Page Developer Tools',
            accelerator: process.platform === 'darwin' ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
            enabled: inBrowser,
            click: () => selectedTab()?.view.webContents.openDevTools({ mode: 'detach' }),
          },
          {
            label: 'Test Seat Matcher on This Tab…',
            enabled: inBrowser,
            click: () => win?.webContents.send('open-seat-test'),
          },
        ]),
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Proxy',
      submenu: [
        { label: 'Burn IP and Reload', accelerator: A.burn, enabled: can, click: send('burn') },
        {
          label: globalMute ? 'Unmute All Tabs' : 'Mute All Tabs',
          accelerator: A.muteAll,
          enabled: inBrowser,
          click: () => toggleGlobalMute(),
        },
        { label: 'Burn IP on All Tabs', accelerator: 'CmdOrCtrl+Alt+B', enabled: can, click: send('burnAll') },
        {
          label: selectedTab()?.proxy ? 'Switch to Local IP' : 'Switch to Proxy',
          accelerator: A.toggleProxy,
          enabled: can,
          click: send('toggleProxy'),
        },
        { type: 'separator' },
        {
          label: 'Check Pool & Remove Flagged IPs…',
          enabled: inBrowser && pool?.enabled && pool?.kind === 'list',
          click: async () => {
            const result = await scanProxyPool();
            if (result?.error) notify(result.error);
          },
        },
      ],
    },
    {
      label: 'Profiles',
      submenu: [
        { label: 'Autofill From Profile', accelerator: A.autofill, enabled: inBrowser, click: send('autofill') },
        {
          // These two accelerators are what wins over Chromium's own Cmd+1 / Cmd+2 (switch to tab N).
          // The click handler sends an IPC the renderer catches; the renderer then iterates its
          // multi-select set (or just the selected tab) and runs the same bulk action as the
          // in-renderer keyboard listener. Having both lets the shortcut work no matter whether the
          // TabFleet UI or a tab's page has focus.
          label: 'Auto-Login on Selected Tabs',
          accelerator: A.bulkAutoLogin,
          enabled: inBrowser,
          click: () => win?.webContents.send('bulk-shortcut', 'autoLogin'),
        },
        {
          label: 'Autofill + Submit on Selected Tabs',
          accelerator: A.bulkAutofillSubmit,
          enabled: inBrowser,
          click: () => win?.webContents.send('bulk-shortcut', 'autofillSubmit'),
        },
        {
          label: 'Go Home on Selected Tabs',
          accelerator: A.bulkHome,
          enabled: inBrowser,
          click: () => win?.webContents.send('bulk-shortcut', 'home'),
        },
        {
          label: 'Profiles Panel',
          accelerator: A.profilesPanel,
          enabled: inBrowser,
          click: () => win.webContents.send('toggle-panel', 'profiles'),
        },
        { label: 'Orders', accelerator: 'CmdOrCtrl+Shift+U', click: () => { win?.webContents.focus(); win?.webContents.send('open-orders'); } },
        { type: 'separator' },
        {
          label: 'Check All Account Logins',
          enabled: inBrowser,
          click: async () => {
            notify(`Checking ${profiles.filter(inActiveGroup).length} account(s)…`);
            const { results } = await runAccountHealthCheck();
            const inCount = results.filter((r) => r.status === 'in').length;
            const outCount = results.filter((r) => r.status === 'out').length;
            notify(`Logged in: ${inCount} · Logged out: ${outCount} · Unknown: ${results.length - inCount - outCount}`);
          },
        },
        { type: 'separator' },
        { label: 'Import Profiles (CSV)…', click: () => importProfilesFile().then((result) => result && win?.webContents.send('profiles-imported', result)) },
        { label: 'Import From Google Sheet…', enabled: inBrowser, click: () => win.webContents.send('open-sheet-import') },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  lastStateJSON = '';
  menuKey = '';
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 760,
    minHeight: 480,
    title: 'TabFleet',
    backgroundColor: '#0a0a0b',
    frame: true,                  // explicit so Windows draws its standard min / max / close controls
    autoHideMenuBar: false,       // keep the menu bar visible on Windows so File / Window menus are reachable
    minimizable: true,
    maximizable: true,
    closable: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true },
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.on('page-title-updated', (event) => event.preventDefault());
  win.webContents.once('did-finish-load', updateWindowTitle);
  win.on('resize', layout);
  win.on('focus', () => win.flashFrame(false));
  win.on('closed', () => {
    win = null;
  });
  // The chrome UI is local and never navigates or opens windows.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  // Right-click context menu for the TabFleet UI itself (address bar, notes, profile forms,
  // settings fields). Without this, right-click on an input in the chrome does nothing. Mirrors
  // what we already give page content: Cut / Copy / Paste / Select All, with edit-flag gating.
  win.webContents.on('context-menu', (_event, params) => {
    const t = [];
    if (params.isEditable) {
      t.push(
        { role: 'undo', enabled: params.editFlags.canUndo },
        { role: 'redo', enabled: params.editFlags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { role: 'selectAll', enabled: params.editFlags.canSelectAll },
      );
    } else if (params.selectionText && params.selectionText.trim()) {
      t.push({ role: 'copy' });
    } else {
      return; // nothing meaningful to show on a blank area of the chrome
    }
    Menu.buildFromTemplate(t).popup({ window: win });
  });
  updateMenu();
}

// ─────────────────────────────────────────────── Licensing + telemetry
// A valid license is required before the main window opens. If none is cached, a login window
// takes the user through activation; cached tokens let the app launch offline for up to 7 days.
// Telemetry is a thin event stream — fire-and-forget, batched to disk, flushed to the API every
// 60s. Set TABFLEET_API_BASE in the env or settings.apiBase to override the server URL.

let licenseClient = null;
let telemetryClient = null;

function getLicenseApiBase() {
  return process.env.TABFLEET_API_BASE || settings?.apiBase || 'https://tabfleet-api.example.workers.dev';
}

function initLicenseAndTelemetry() {
  if (licenseClient && telemetryClient) return;
  const dataDir = app.getPath('userData');
  const appVersion = app.getVersion();
  licenseClient = createLicenseClient({ apiBase: getLicenseApiBase(), dataDir, appVersion });
  telemetryClient = createTelemetryClient({
    apiBase: getLicenseApiBase(),
    dataDir,
    appVersion,
    deviceId: licenseClient.deviceId,
    getLicenseKey: () => licenseClient.currentLicenseKey(),
    enabled: settings?.telemetryEnabled !== false,
  });
  telemetryClient.start();

  // Pipe uncaught errors into the telemetry queue.
  process.on('uncaughtException', (err) => telemetryClient?.trackError(err, { kind: 'crash' }));
  process.on('unhandledRejection', (reason) => telemetryClient?.trackError(reason, { kind: 'crash' }));
}

// Shows the login window and resolves once the user successfully activates (or `null` on quit).
function showLoginWindow({ reason = 'no_license' } = {}) {
  return new Promise((resolve) => {
    const loginWin = new BrowserWindow({
      width: 500, height: 640, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      title: 'TabFleet — Activate',
      backgroundColor: '#0a0b0f',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      webPreferences: {
        preload: path.join(__dirname, 'license', 'login-preload.js'),
        contextIsolation: true, sandbox: false, nodeIntegration: false,
      },
    });
    loginWin.setMenuBarVisibility(false);
    loginWin.loadFile(path.join(__dirname, 'license', 'login.html'));
    if (reason && reason !== 'no_license') {
      loginWin.webContents.once('did-finish-load', () => {
        const msg = reason === 'revoked' ? 'This license was revoked. Please activate a different key.'
                  : reason === 'device_revoked' ? 'This device was removed from the license. Re-activate to continue.'
                  : reason === 'expired' ? 'This license has expired. Activate a renewed key.'
                  : reason === 'expired_offline' ? 'Offline grace period expired. Reconnect to re-validate.'
                  : null;
        if (msg) loginWin.webContents.executeJavaScript(
          `(() => { const s = document.getElementById('status'); if (s) { s.className = 'status err'; s.textContent = ${JSON.stringify(msg)}; } })()`,
        ).catch(() => {});
      });
    }
    ipcMain.once('license:proceed', () => { try { loginWin.close(); } catch {} resolve(true); });
    loginWin.on('closed', () => resolve(false));
  });
}

ipcMain.handle('license:device-info', () => ({
  deviceId: licenseClient?.deviceId || 'unknown',
  deviceLabel: licenseClient?.deviceLabel || 'unknown device',
}));

ipcMain.handle('license:activate', async (_event, key) => {
  if (!licenseClient) return { ok: false, error: 'not_ready' };
  const result = await licenseClient.activate(key);
  if (result.ok) telemetryClient?.trackEvent('license.activated', { plan: result.plan });
  else telemetryClient?.trackEvent('license.activation_failed', { reason: result.error });
  return result;
});

ipcMain.handle('license:info', () => ({
  key: licenseClient?.currentLicenseKey() || null,
  plan: licenseClient?.currentPlan() || null,
  deviceId: licenseClient?.deviceId || null,
}));

ipcMain.handle('license:deactivate', () => {
  licenseClient?.deactivate();
  telemetryClient?.trackEvent('license.deactivated');
  return { ok: true };
});

app.whenReady().then(async () => {
  loadSettings();
  initLicenseAndTelemetry();

  // License gate — if no valid license, show the login window first and loop until the user
  // either activates successfully or quits the window.
  let licenseResult = await licenseClient.validateAtStartup();
  while (!licenseResult.ok) {
    const activated = await showLoginWindow({ reason: licenseResult.reason });
    if (!activated) { app.quit(); return; }
    licenseResult = await licenseClient.validateAtStartup();
  }
  telemetryClient?.trackEvent('app.launch', { plan: licenseResult.plan, source: licenseResult.source });

  // Re-validate every 6 hours so revocations propagate without a restart.
  setInterval(async () => {
    const r = await licenseClient.validateAtStartup();
    if (!r.ok) {
      telemetryClient?.trackEvent('license.lost', { reason: r.reason });
      dialog.showMessageBox({ type: 'error', message: 'TabFleet license is no longer valid', detail: `Reason: ${r.reason}. The app will close.` });
      app.quit();
    }
  }, 6 * 60 * 60 * 1000).unref?.();

  // macOS / Linux: start in the timezone of the last session's proxies (it only applies from a start).
  if (!CLOCK_LOG && process.platform !== 'win32' && !settings.pendingLaunch && settings.matchProxyTimezone
    && settings.clockZone && process.env.TZ !== settings.clockZone) {
    restartWithClock(settings.clockZone);
    return;
  }
  if (process.platform !== 'win32') clockZone = settings.matchProxyTimezone && process.env.TZ ? process.env.TZ : null;
  // Windows: a timezone left set by a TabFleet that didn't quit normally goes back first.
  await restoreWindowsClock();
  await Promise.all([loadProfiles(), loadSyncCredentials()]);
  // Only with the accounts loaded: an unreadable profiles file must never look like "no accounts".
  if (profiles.length > 0) await removeOrphanPartitions();
  createWindow();
  startAutoUpdater();
  ensureActiveGroup();
  if (settings.autoOpenOrders) startOrderWatcher();
  // Restarted to set the clock: continue the launch the user started.
  if (settings.pendingLaunch) {
    settings.pendingLaunch = false;
    persistSettings();
    win.webContents.once('did-finish-load', () => {
      startSession(config).catch((error) => notify(error.message || 'Could not start the session.'));
    });
  }
});

// Windows: put the computer's own timezone back.
app.on('will-quit', () => {
  if (process.platform !== 'win32' || !settings?.restoreZone || CLOCK_LOG) return;
  try {
    execFileSync('tzutil', ['/s', settings.restoreZone], { windowsHide: true, timeout: 15000 });
    settings.restoreZone = null;
    persistSettings();
  } catch {}
});

/**
 * Auto-update from GitHub Releases. User data (profiles, snippets, session partitions) lives in the
 * userData directory, which the installer never touches — nothing is deleted on update. Only packaged
 * builds talk to the update server; a dev `electron .` run reports "unsupported" instead.
 *
 * The latest status is kept here (not only pushed to the window) so Settings can show it whenever it
 * opens, including a check that finished before the window had loaded.
 */
const UPDATE_CHECK_INTERVAL = 2 * 60 * 60 * 1000;
const SETTINGS_DEFAULTS = { autoDownload: true, notifyUpdates: true, matchProxyTimezone: true, autoOpenOrders: false };
let settings = { ...SETTINGS_DEFAULTS };
let autoUpdater = null;
let updateStatus = { kind: 'idle' };
let lastChecked = null;
let manualCheck = false;
let notifiedVersion = null;

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(dataPath('settings.json'), 'utf8'));
    settings = Object.fromEntries(Object.entries(SETTINGS_DEFAULTS)
      .map(([key, fallback]) => [key, typeof saved[key] === 'boolean' ? saved[key] : fallback]));
    settings.activeGroup = typeof saved.activeGroup === 'string' ? saved.activeGroup : null;
    settings.clockZone = typeof saved.clockZone === 'string' ? saved.clockZone : null;
    settings.restoreZone = typeof saved.restoreZone === 'string' ? saved.restoreZone : null;
    settings.pendingLaunch = saved.pendingLaunch === true;
    settings.groupNames = saved.groupNames && typeof saved.groupNames === 'object'
      ? Object.fromEntries(Object.entries(saved.groupNames).filter(([, v]) => typeof v === 'string'))
      : {};
  } catch {
    settings = { ...SETTINGS_DEFAULTS, activeGroup: null, groupNames: {}, clockZone: null, restoreZone: null, pendingLaunch: false };
  }
}

function saveSettings(input) {
  for (const key of Object.keys(SETTINGS_DEFAULTS)) {
    if (typeof input?.[key] === 'boolean') settings[key] = input[key];
  }
  writeData('settings.json', settings);
  if (typeof input?.matchProxyTimezone === 'boolean') clockSettingChanged();
  if (typeof input?.autoOpenOrders === 'boolean') {
    if (settings.autoOpenOrders) startOrderWatcher();
    else stopOrderWatcher();
  }
  if (autoUpdater) {
    autoUpdater.autoDownload = settings.autoDownload;
    // Turning auto-download on while an update is waiting: fetch it now.
    if (settings.autoDownload && updateStatus.kind === 'available') autoUpdater.downloadUpdate().catch(() => {});
  }
  return updateInfo();
}

function updateInfo() {
  return { version: app.getVersion(), supported: Boolean(autoUpdater), settings: { ...settings }, status: updateStatus, lastChecked };
}

/** First line of an updater error, without the HTTP headers / stack electron-updater appends. */
function shortError(error) {
  return String(error?.message ?? error ?? 'Unknown error').split('\n')[0].slice(0, 200);
}

function setUpdateStatus(status) {
  updateStatus = { ...status, manual: manualCheck };
  if (['up-to-date', 'error', 'available', 'downloaded'].includes(status.kind)) lastChecked = Date.now();
  if (['up-to-date', 'error', 'downloaded'].includes(status.kind)) manualCheck = false;
  win?.webContents.send('update-status', updateInfo());
  const ready = status.kind === 'downloaded' || (status.kind === 'available' && !settings.autoDownload);
  if (ready && settings.notifyUpdates && Notification.isSupported() && notifiedVersion !== `${status.kind}:${status.version}`) {
    notifiedVersion = `${status.kind}:${status.version}`;
    const notice = new Notification({
      title: status.kind === 'downloaded' ? `TabFleet ${status.version} is ready` : `TabFleet ${status.version} is available`,
      body: status.kind === 'downloaded'
        ? 'Restart TabFleet to install it. Your profiles and tabs are kept.'
        : 'Open Settings to download it.',
    });
    notice.on('click', () => {
      if (!win) return;
      win.show();
      win.focus();
      win.webContents.send('open-settings');
    });
    notice.show();
  }
}

async function checkForUpdates({ manual = false } = {}) {
  if (!autoUpdater) return updateInfo();
  if (['checking', 'progress'].includes(updateStatus.kind)) return updateInfo();
  if (updateStatus.kind === 'downloaded') return updateInfo();
  manualCheck = manual;
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    setUpdateStatus({ kind: 'error', message: shortError(error) });
  }
  return updateInfo();
}

function startAutoUpdater() {
  loadSettings();
  ipcMain.handle('update:get-info', () => updateInfo());
  ipcMain.handle('update:check-now', () => checkForUpdates({ manual: true }));
  ipcMain.handle('update:download', () => {
    if (autoUpdater && updateStatus.kind === 'available') {
      autoUpdater.downloadUpdate().catch((error) => setUpdateStatus({ kind: 'error', message: shortError(error) }));
    }
    return updateInfo();
  });
  ipcMain.handle('update:install-now', () => {
    if (autoUpdater && updateStatus.kind === 'downloaded') setImmediate(() => autoUpdater.quitAndInstall());
  });
  ipcMain.handle('settings:save', (_event, input) => saveSettings(input));

  if (!app.isPackaged) {
    updateStatus = { kind: 'unsupported' };
    return;
  }
  try { autoUpdater = require('electron-updater').autoUpdater; }
  catch {
    updateStatus = { kind: 'unsupported' };
    return;
  }
  // Fully offline-friendly: an unreachable update server does not break the app.
  autoUpdater.autoDownload = settings.autoDownload;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (error) => setUpdateStatus({ kind: 'error', message: shortError(error) }));
  autoUpdater.on('checking-for-update', () => setUpdateStatus({ kind: 'checking' }));
  autoUpdater.on('update-available', (info) => setUpdateStatus({ kind: 'available', version: info.version, downloading: settings.autoDownload }));
  autoUpdater.on('update-not-available', () => setUpdateStatus({ kind: 'up-to-date' }));
  autoUpdater.on('download-progress', (p) => setUpdateStatus({ kind: 'progress', version: updateStatus.version, percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => setUpdateStatus({ kind: 'downloaded', version: info.version }));
  // Initial check on startup, then every 2 hours.
  checkForUpdates();
  setInterval(() => checkForUpdates(), UPDATE_CHECK_INTERVAL);
}

app.on('window-all-closed', () => {
  endSession();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!win) {
    mode = 'launcher';
    createWindow();
  }
});
