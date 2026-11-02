'use strict';

const $ = (selector) => document.querySelector(selector);

const launcher = $('#launcher');
const browser = $('#browser');
const form = $('#launch-form');
const launchError = $('#launch-error');
const tabsEl = $('#tabs');
const address = $('#address');
const panel = $('#panel');
const noteEl = $('#note');

const PANEL_WIDTH = 320;

let state = { mode: 'launcher', tabs: [], selectedId: null, perTabProxies: false, regions: [] };
let palette = [];
let snippets = [];
let editingSnippets = false;
let profiles = [];
const checkedProfiles = new Set();
// An order's event search waiting for the user to pick a profile (the tab opens in that profile's session).
let pendingSearch = null;

const command = (name, tabId, arg) => window.fleet.command(name, tabId, arg);

// ---------- Launcher ----------

function fillForm(config) {
  for (const element of form.elements) {
    if (!element.name) continue;
    const value = element.name.split('.').reduce((object, key) => object?.[key], config);
    if (element.type === 'radio') element.checked = element.value === value;
    else if (element.type === 'checkbox') element.checked = Boolean(value);
    else if (value !== undefined) element.value = value;
  }
  applyTheme(config.theme);
  showProxyFields();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = ['light', 'dark'].includes(theme) ? theme : 'system';
}

function readForm() {
  const config = { rotating: {} };
  for (const element of form.elements) {
    if (!element.name || (element.type === 'radio' && !element.checked)) continue;
    let value = element.value;
    if (element.type === 'number') value = Number(value);
    if (element.type === 'checkbox') value = element.checked;
    const [key, subkey] = element.name.split('.');
    if (subkey) {
      config[key] ??= {};
      config[key][subkey] = value;
    }
    else config[key] = value;
  }
  return config;
}

function showProxyFields() {
  const source = form.elements.proxySource.value;
  for (const group of form.querySelectorAll('[data-source]')) {
    group.hidden = group.dataset.source !== source;
  }
  form.querySelector('[data-needs-proxy]').hidden = source === 'none';
}

function showLaunchError(message) {
  launchError.textContent = message ?? '';
  launchError.hidden = !message;
}

form.addEventListener('change', (event) => {
  if (event.target.name === 'proxySource') showProxyFields();
  if (event.target.name === 'theme') applyTheme(event.target.value);
  showLaunchError(null);
});

// Scan the proxy list in-place: route a request through each entry to ipquery.io, remove the ones
// flagged (datacenter/VPN/TOR/known-proxy/risk≥70/unreachable), and leave the cleaned list in the
// textarea so the user can review before launching. The check runs in the main process; this view
// just updates the status line and swaps the textarea content when it finishes.
const proxyCheckBtn = $('#proxy-check-btn');
const proxyCheckStatus = $('#proxy-check-status');
if (proxyCheckBtn) {
  proxyCheckBtn.addEventListener('click', async () => {
    const textarea = form.elements.proxyList;
    const text = textarea.value.trim();
    if (!text) {
      proxyCheckStatus.textContent = 'Paste at least one proxy first.';
      return;
    }
    proxyCheckBtn.disabled = true;
    proxyCheckStatus.textContent = 'Checking…';
    try {
      const result = await window.fleet.scanProxyText(text);
      if (result?.error) {
        proxyCheckStatus.textContent = result.error;
        return;
      }
      textarea.value = result.cleanedText;
      const remaining = result.total - result.removed;
      proxyCheckStatus.textContent = result.removed === 0
        ? `All ${result.total} proxies passed.`
        : remaining === 0
          ? `⚠ All ${result.total} failed and were removed — no usable proxies left. Add working proxies before launching.`
          : `Removed ${result.removed} of ${result.total}; ${remaining} remain.`;
    } catch (error) {
      proxyCheckStatus.textContent = `Check failed: ${error?.message || 'unknown error'}`;
    } finally {
      proxyCheckBtn.disabled = false;
    }
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if ((state.groups?.length ?? 0) > 1 && !form.querySelector('[name="group"]:checked')) {
    showLaunchError('Choose the group of accounts to work in.');
    $('#launch-group').scrollIntoView({ block: 'nearest' });
    return;
  }
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    showLaunchError(await window.fleet.launch(readForm()));
  } catch (error) {
    // A rejected launch() used to vanish as an unhandled rejection with no visible feedback.
    showLaunchError(error?.message || 'Launch failed. Check the logs and try again.');
  } finally {
    button.disabled = false;
  }
});

// ---------- Tab strip & toolbar ----------

function selectedTab() {
  return state.tabs.find((tab) => tab.id === state.selectedId) ?? null;
}

function formatRemaining(endsAt) {
  const seconds = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
    : `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

// Multi-select state. `multi` is a Set of tab ids the user has marked (via Shift/Cmd-click or Cmd-A)
// in addition to the main `selectedId`. The main process doesn't know about multi-select; it's a
// pure renderer concept that drives bulk commands (e.g. Close selected tabs) when the user acts.
const multi = new Set();

function renderTabs() {
  // Index existing DOM by role-prefixed key so group chips and tab divs don't collide.
  const existing = new Map();
  for (const el of tabsEl.children) {
    const k = el.dataset.id ? `tab:${el.dataset.id}` : el.dataset.groupId ? `grp:${el.dataset.groupId}` : null;
    if (k) existing.set(k, el);
  }
  const collapsedGroups = new Set((state.tabGroups || []).filter((g) => g.collapsed).map((g) => g.id));
  const emittedGroups = new Set();
  const nextChildren = [];

  const buildOrUpdateGroupChip = (grp) => {
    const key = `grp:${grp.id}`;
    let el = existing.get(key);
    if (!el) {
      el = document.createElement('div');
      el.className = 'group-chip';
      el.dataset.groupId = grp.id;
      el.innerHTML = '<span class="gc-dot"></span><span class="gc-name"></span><span class="gc-count"></span>';
    }
    existing.delete(key);
    const members = state.tabs.filter((t) => t.groupId === grp.id).length;
    el.querySelector('.gc-dot').style.background = grp.color;
    el.querySelector('.gc-name').textContent = grp.name;
    el.querySelector('.gc-count').textContent = grp.collapsed ? `+${members}` : '';
    el.style.setProperty('--group-color', grp.color);
    el.classList.toggle('collapsed', Boolean(grp.collapsed));
    return el;
  };

  const buildOrUpdateTab = (tab) => {
    const key = `tab:${tab.id}`;
    let el = existing.get(key);
    if (!el) {
      el = document.createElement('div');
      el.className = 'tab';
      el.dataset.id = tab.id;
      el.setAttribute('role', 'tab');
      el.innerHTML = '<span class="pin-dot" hidden title="Pinned"></span><span class="slot"></span><img class="favicon" alt="" hidden><span class="spinner" hidden></span>'
        + '<span class="title"></span>'
        + '<span class="order-chip" hidden title="Attached order"></span>'
        + '<span class="note-dot" hidden title="Has a note"></span><span class="timer" hidden></span>'
        + '<span class="load-bar" hidden></span>'
        + '<button class="close" aria-label="Close tab">×</button>';
    }
    existing.delete(key);
    el.querySelector('.slot').textContent = tab.slot;
    el.querySelector('.title').textContent = tab.title;
    el.querySelector('.spinner').hidden = !tab.loading;
    el.querySelector('.load-bar').hidden = !tab.loading;
    el.querySelector('.note-dot').hidden = !tab.note;
    el.querySelector('.pin-dot').hidden = !tab.pinned;
    el.classList.toggle('pinned', Boolean(tab.pinned));
    el.classList.toggle('attention', Boolean(tab.attention));
    el.classList.toggle('in-group', Boolean(tab.groupId));
    const chip = el.querySelector('.order-chip');
    if (tab.orderId) { chip.textContent = `#${tab.orderId}`; chip.hidden = false; }
    else chip.hidden = true;
    const fav = el.querySelector('.favicon');
    if (tab.favicon && !tab.loading) {
      if (fav.src !== tab.favicon) fav.src = tab.favicon;
      fav.hidden = false;
    } else fav.hidden = true;
    const timer = el.querySelector('.timer');
    timer.hidden = !tab.timerEndsAt && !tab.timerDone;
    timer.dataset.endsAt = tab.timerEndsAt ?? '';
    timer.textContent = tab.timerDone ? 'Check' : tab.timerEndsAt ? formatRemaining(tab.timerEndsAt) : '';
    // The native hover tooltip (title/url/proxy/profile) was cluttery and intrusive. Clear it so
    // nothing pops when hovering a tab. Users can still see the URL in the address bar and the
    // proxy/profile in the bottom status strip.
    el.title = '';
    el.removeAttribute('title');
    el.classList.toggle('has-error', Boolean(tab.error));
    el.classList.toggle('timer-done', tab.timerDone);
    // When the multi-set is active, the currently focused tab counts as part of the bulk target
    // too — give it the same multi-selected ring so the user sees "yes this one is included".
    el.classList.toggle('multi-selected', multi.has(tab.id) || (multi.size > 0 && tab.id === state.selectedId));
    if (tab.groupId) {
      const grp = (state.tabGroups || []).find((g) => g.id === tab.groupId);
      if (grp) el.style.setProperty('--group-color', grp.color);
    } else el.style.removeProperty('--group-color');
    if (tab.color) el.style.setProperty('--tab-color', tab.color);
    else el.style.removeProperty('--tab-color');
    el.setAttribute('aria-selected', String(tab.id === state.selectedId));
    return el;
  };

  state.tabs.forEach((tab) => {
    // First tab of a group → emit the chip before it. Then skip member rendering if collapsed.
    if (tab.groupId && !emittedGroups.has(tab.groupId)) {
      emittedGroups.add(tab.groupId);
      const grp = (state.tabGroups || []).find((g) => g.id === tab.groupId);
      if (grp) nextChildren.push(buildOrUpdateGroupChip(grp));
    }
    if (tab.groupId && collapsedGroups.has(tab.groupId)) return;
    nextChildren.push(buildOrUpdateTab(tab));
  });

  // Reconcile DOM to the computed order.
  for (let i = 0; i < nextChildren.length; i++) {
    const el = nextChildren[i];
    if (tabsEl.children[i] !== el) tabsEl.insertBefore(el, tabsEl.children[i] ?? null);
  }
  for (const el of existing.values()) {
    if (el.dataset.id) multi.delete(el.dataset.id);
    el.remove();
  }
  if (renderTabs.scrolledTo !== state.selectedId) {
    renderTabs.scrolledTo = state.selectedId;
    tabsEl.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

function renderGroupBadge() {
  const badge = $('#group-badge');
  const active = activeGroupInfo();
  const show = (state.groups?.length ?? 0) > 1 || (Boolean(active) && active.key !== '');
  badge.hidden = !show;
  badge.classList.toggle('needs-choice', !active);
  $('.group-badge-name').textContent = active ? active.name : 'Choose group';
  browser.style.setProperty('--group-color', show && active ? active.color : 'transparent');
}

function renderToolbar() {
  renderGroupBadge();
  const tab = selectedTab();
  $('[data-cmd="back"]').disabled = !tab?.canGoBack;
  $('[data-cmd="forward"]').disabled = !tab?.canGoForward;
  const reload = $('#reload');
  reload.textContent = tab?.loading ? '×' : '↻';
  reload.title = tab?.loading ? 'Stop' : 'Reload (Ctrl/⌘ R)';
  for (const button of document.querySelectorAll('[data-cmd="burn"], [data-cmd="burnAll"]')) {
    button.disabled = !state.perTabProxies;
  }
  if (document.activeElement !== address) address.value = tab?.url ?? '';

  const toggle = $('#proxy-toggle');
  toggle.disabled = !state.perTabProxies;
  toggle.textContent = tab?.proxy ? `● ${tab.proxy}` : '○ Local IP';
  toggle.classList.toggle('direct', !tab?.proxy);
  toggle.title = state.perTabProxies
    ? `${tab?.proxy ? 'Switch this tab to your local IP' : 'Switch this tab to a proxy'} without losing its session (Ctrl/⌘ Shift P)`
    : 'Per-tab proxies need a proxy source and separate sessions';

  const region = $('#region');
  region.hidden = !state.perTabProxies || state.regions.length === 0;
  if ([...region.options].map((o) => o.value).join() !== state.regions.join()) {
    region.replaceChildren(...state.regions.map((code) => new Option(code.toUpperCase(), code)));
  }
  region.value = tab?.region ?? '';

  // Error strip disabled — the backend still tracks tab.error, but the inline red bar at the top
  // of the page area is suppressed because it clutters the browser view. Errors still appear via
  // the Recent messages popover (🕘 button on the status strip) and the per-tab `has-error`
  // outline on the strip entry, so the user still sees that something failed.
  $('#error-bar').hidden = true;

  // The 🧹 Clear button adapts to multi-select. When any extras are selected it switches to a
  // "Clear all selected" mode that wipes cookies on every selected tab; otherwise it keeps the
  // original "Clear this tab + new IP + home" behavior.
  const clearBtn = $('#clear-tab-btn');
  if (clearBtn) {
    const n = selectedTabIds().length;
    if (multi.size > 0 && n > 1) {
      clearBtn.textContent = `🧹 Clear ${n} tabs`;
      clearBtn.title = `Clear cookies on all ${n} selected tabs.`;
      clearBtn.dataset.mode = 'bulk';
    } else {
      clearBtn.textContent = '🧹 Clear tab';
      clearBtn.title = "Clear this tab's cookies, cache and saved logins, give it a new IP from the pool, and reload";
      clearBtn.dataset.mode = 'single';
    }
  }
}

// ---------- Tools panel ----------

function setPanelOpen(open) {
  panel.hidden = !open;
  $('#panel-toggle').setAttribute('aria-pressed', String(open));
  try {
    localStorage.setItem('panelOpen', open ? '1' : '');
  } catch {}
  reportInsets();
  if (open) renderPanel();
}

function renderSwatches() {
  const container = $('#swatches');
  const none = document.createElement('button');
  none.className = 'swatch none';
  none.textContent = '∅';
  none.title = 'No color';
  none.dataset.color = '';
  container.replaceChildren(none, ...palette.map(({ name, hex }) => {
    const button = document.createElement('button');
    button.className = 'swatch';
    button.title = name;
    button.dataset.color = hex;
    button.style.setProperty('--swatch', hex);
    return button;
  }));
  for (const button of container.children) button.setAttribute('role', 'radio');
}

function renderPanel() {
  const tab = selectedTab();
  // A hidden panel is rendered when it opens; skipping it keeps busy tabs from re-rendering it.
  if (!tab || panel.hidden) return;
  for (const swatch of $('#swatches').children) {
    swatch.setAttribute('aria-checked', String((swatch.dataset.color || null) === tab.color));
  }
  $('#timer-running').hidden = !tab.timerEndsAt;
  $('#timer-left').textContent = tab.timerEndsAt ? formatRemaining(tab.timerEndsAt) : '';
  renderProfilePanel(tab);
  if (noteEl.dataset.tabId !== tab.id) flushNote();
  if ((document.activeElement !== noteEl && !noteTimer) || noteEl.dataset.tabId !== tab.id) {
    noteEl.value = tab.note;
    noteEl.dataset.tabId = tab.id;
  }
}

function renderSnippets() {
  const list = $('#snippets');
  list.replaceChildren(...snippets.map((snippet) => {
    const item = document.createElement('li');
    const label = document.createElement('div');
    label.className = 'label';
    const name = document.createElement('strong');
    name.textContent = snippet.label;
    const value = document.createElement('span');
    value.textContent = snippet.secret ? '••••••' : snippet.value;
    label.append(name, value);
    item.append(label);
    const buttons = editingSnippets
      ? [['Remove', 'remove']]
      : [['Insert', 'insert'], ['Copy', 'copy']];
    for (const [text, action] of buttons) {
      const button = document.createElement('button');
      button.textContent = text;
      button.className = action;
      button.dataset.action = action;
      button.dataset.id = snippet.id;
      item.append(button);
    }
    return item;
  }));
  $('#snippet-form').hidden = !editingSnippets;
  $('#snippet-edit').textContent = editingSnippets ? 'Done' : 'Edit';
}

$('#panel-toggle').addEventListener('click', () => setPanelOpen(panel.hidden));

// Kebab-menu: toggles under the toolbar; closes when a button inside it is clicked, or on outside click.
// ⋯ is a native menu: anything drawn in this window under the toolbar would sit behind the page.
$('#more-menu-btn').addEventListener('click', () => command('moreMenu'));
window.fleet.onTogglePanel((section) => {
  if (section === 'profiles' || section === 'pick-profile') {
    setPanelOpen(true);
    togglePicker(true);
  } else {
    setPanelOpen(panel.hidden);
  }
});

$('#swatches').addEventListener('click', (event) => {
  const swatch = event.target.closest('.swatch');
  if (swatch) command('setColor', state.selectedId, swatch.dataset.color || null);
});

$('#timer-presets').addEventListener('click', (event) => {
  const minutes = event.target.dataset?.minutes;
  if (minutes) command('setTimer', state.selectedId, Number(minutes));
});
$('#timer-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const minutes = Number($('#timer-minutes').value);
  if (minutes > 0) command('setTimer', state.selectedId, minutes);
  $('#timer-minutes').value = '';
});
$('#timer-clear').addEventListener('click', () => command('setTimer', state.selectedId, 0));

// Notes save shortly after typing stops; until then renderPanel must not overwrite the textarea.
let noteTimer = null;
function flushNote() {
  if (!noteTimer) return;
  clearTimeout(noteTimer);
  noteTimer = null;
  command('setNote', noteEl.dataset.tabId, noteEl.value);
}
noteEl.addEventListener('input', () => {
  clearTimeout(noteTimer);
  noteTimer = setTimeout(flushNote, 300);
});
noteEl.addEventListener('blur', flushNote);
// Cmd/Ctrl + Shift + T inside the note inserts the current time, so a rep can mark events as they
// happen ("22:04 joined queue", "22:11 reached checkout") without reaching for the mouse.
noteEl.addEventListener('keydown', (event) => {
  if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== 't') return;
  event.preventDefault();
  const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const start = noteEl.selectionStart ?? noteEl.value.length;
  const end = noteEl.selectionEnd ?? noteEl.value.length;
  const insert = (noteEl.value.slice(0, start).endsWith('\n') || start === 0 ? '' : '\n') + stamp + ' ';
  noteEl.setRangeText(insert, start, end, 'end');
  noteEl.dispatchEvent(new Event('input', { bubbles: true }));
});
$('#note-copy').addEventListener('click', () => command('copy', undefined, noteEl.value));
$('#note-insert').addEventListener('click', () => command('insertText', state.selectedId, noteEl.value));

$('#snippet-edit').addEventListener('click', () => {
  editingSnippets = !editingSnippets;
  renderSnippets();
});
$('#snippets').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const snippet = snippets.find((s) => s.id === button.dataset.id);
  if (!snippet) return;
  if (button.dataset.action === 'insert') command('insertText', state.selectedId, snippet.value);
  if (button.dataset.action === 'copy') command('copy', undefined, snippet.value);
  if (button.dataset.action === 'remove') {
    snippets = snippets.filter((s) => s !== snippet);
    await window.fleet.saveSnippets(snippets);
    renderSnippets();
  }
});
$('#snippet-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const fields = event.target.elements;
  snippets.push({
    id: crypto.randomUUID(),
    label: fields.label.value.trim(),
    value: fields.value.value,
    secret: fields.secret.checked,
  });
  await window.fleet.saveSnippets(snippets);
  event.target.reset();
  renderSnippets();
});

// ---------- Profiles ----------

function showNotice(text, timeout) {
  const notice = $('#notice');
  notice.textContent = text;
  notice.hidden = !text;
  // Multi-line reports (import, test sync) need pre-wrap and a longer window to read.
  const multiline = typeof text === 'string' && text.includes('\n');
  notice.style.whiteSpace = multiline ? 'pre-wrap' : '';
  clearTimeout(showNotice.timer);
  // Honour an explicit duration — error/action toasts (playbook, bulk, license) pass a longer time
  // and used to be dropped at the default 5s.
  const ms = timeout ?? (multiline ? 30000 : 5000);
  if (text) showNotice.timer = setTimeout(() => { notice.hidden = true; notice.style.whiteSpace = ''; }, ms);
}

function describeImport(result) {
  if (!result) return '';
  const lines = [`Imported ${result.imported} profile(s); ${result.total} saved.`];
  if (result.sheets?.length) lines.push(...result.sheets);
  if (result.notes?.length) lines.push(...result.notes);
  if (result.recognised?.length) lines.push(`Recognised columns: ${result.recognised.join('; ')}`);
  if (result.ignored?.length) lines.push(`Ignored columns (unrecognised): ${result.ignored.join(', ')}`);
  const fixes = (result.errors ?? []).filter((e) => /Fixed automatically/.test(e));
  const problems = (result.errors ?? []).filter((e) => !fixes.includes(e));
  if (fixes.length) lines.push(...fixes);
  if (problems.length) lines.push(`Problems (${problems.length}): ${problems.slice(0, 3).join(' · ')}`);
  return lines.join('\n');
}

async function refreshProfiles() {
  profiles = await window.fleet.listProfiles();
  for (const id of [...checkedProfiles]) if (!profiles.some((p) => p.id === id)) checkedProfiles.delete(id);
  render();
  // Keep the bulk-assign checklist current when a profile is imported/deleted while it's open.
  if ($('#profile-section')?.dataset.mode === 'bulk') renderBulkList();
}

// A small palette for auto-generated profile avatars. Chosen for decent contrast against light + dark surfaces.
const AVATAR_COLORS = [
  '#e03131', '#d9480f', '#f08c00', '#2f9e44', '#0ca678', '#1098ad',
  '#1c7ed6', '#4263eb', '#7048e8', '#ae3ec9', '#c2255c', '#495057',
];

/** Returns a stable { color, initials } for the profile — explicit tabColor wins, else hash the name. */
function avatarForProfile(p) {
  const initials = (p.profile || p.name || '?').split(/\s+/).map((w) => w[0] || '').join('').slice(0, 2).toUpperCase() || '?';
  if (p.tabColor && /^#[0-9a-f]{3,8}$/i.test(p.tabColor)) return { color: p.tabColor, initials };
  let hash = 0;
  for (const ch of String(p.id ?? p.profile ?? '')) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  return { color: AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length], initials };
}

/** Builds an avatar <span class="avatar"> for a profile. */
function profileAvatar(profile) {
  const { color, initials } = avatarForProfile(profile);
  const el = document.createElement('span');
  el.className = 'avatar';
  el.textContent = initials;
  el.style.setProperty('--avatar', color);
  return el;
}

// Jancy-style search: free text across profile/name/email/group/site/buyer/notes, plus operators
// group:X, site:X, has:password|proxy|resolver|card, and the bare word "favorite" / "fav".
function searchProfiles(query) {
  const tokens = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return profiles;
  const terms = [];
  const requires = [];
  for (const token of tokens) {
    const colon = token.indexOf(':');
    const key = colon === -1 ? null : token.slice(0, colon);
    const value = colon === -1 ? token : token.slice(colon + 1);
    if (!key) {
      if (token === 'favorite' || token === 'fav' || token === 'starred') requires.push((p) => p.favorite);
      else terms.push(token);
      continue;
    }
    if (key === 'group') requires.push((p) => (p.group ?? '').toLowerCase().includes(value));
    else if (key === 'site') requires.push((p) => (p.site ?? '').toLowerCase().includes(value)
      || (p.resolvers ?? []).some((c) => c.site.toLowerCase().includes(value)));
    else if (key === 'has') {
      if (value === 'password') requires.push((p) => p.hasPassword || p.hasPasswordUrl);
      else if (value === 'resolver') requires.push((p) => (p.resolvers ?? []).length > 0);
      else if (value === 'card') requires.push((p) => (p.cards ?? []).length > 0);
    } else terms.push(token);
  }
  return profiles.filter((p) => {
    const haystack = `${p.profile} ${p.name} ${p.email} ${p.group ?? ''} ${p.site ?? ''} ${p.buyer ?? ''} ${p.notes ?? ''}`.toLowerCase();
    return terms.every((term) => haystack.includes(term)) && requires.every((check) => check(p));
  });
}

/** One-time OTP codes fetched for each profile, shown in the details view until the next fetch. */
const otpCodes = new Map();

function hasOtpSource(profile) {
  const hasResolver = (profile.resolvers ?? []).some((col) =>
    col.entries.some((e) => ['smscode', 'emailcode', 'othercode'].includes(e.field)));
  return Boolean(profile.hasOtpUrl || profile.hasTextChestKey || hasResolver);
}

function hasPasswordSource(profile) {
  return Boolean(profile.hasPassword || profile.hasPasswordUrl
    || (profile.resolvers ?? []).some((col) => col.entries.some((e) => e.field === 'password')));
}

function iconButton(text, action, title, data = {}) {
  const button = Object.assign(document.createElement('button'), { type: 'button', className: 'pd-btn', textContent: text, title });
  button.dataset.action = action;
  Object.assign(button.dataset, data);
  // A glyph like ⧉ or × gives a screen reader no readable name, so fall back to the title: it then
  // announces "Copy Password" instead of the symbol. Buttons whose text is real words keep it.
  if (title && !/[a-z0-9]/i.test(text)) button.setAttribute('aria-label', title);
  return button;
}

/**
 * A read-only "Label [value] ⧉" row. `copy` is either a plain value copied in the window, or
 * { secret: 'field' } — copied by the main process so the secret never reaches the window.
 */
function detailRow(label, value, { copy = value, masked = false, extra = [] } = {}) {
  const row = document.createElement('div');
  row.className = 'pd-row';
  const name = Object.assign(document.createElement('span'), { className: 'pd-label', textContent: label });
  const field = Object.assign(document.createElement('input'), {
    type: masked ? 'password' : 'text', readOnly: true, value: value ?? '', tabIndex: -1,
  });
  field.className = 'pd-value';
  field.setAttribute('aria-label', label); // the pd-label span isn't programmatically tied to the field
  const buttons = document.createElement('span');
  buttons.className = 'pd-buttons';
  if (copy && typeof copy === 'object') buttons.append(iconButton('⧉', 'copy-secret', `Copy ${label}`, { field: copy.secret, label }));
  else if (copy) buttons.append(iconButton('⧉', 'copy', `Copy ${label}`, { value: copy, label }));
  buttons.append(...extra);
  row.append(name, field, buttons);
  return row;
}

function detailHeading(text) {
  return Object.assign(document.createElement('h4'), { className: 'pd-heading', textContent: text });
}

/** Renders the Jancy-style detail list for the profile on the current tab. */
function renderProfileDetails(profile, tab) {
  const details = $('#profile-details');
  const empty = $('#profile-empty');
  // Rebuild only when something shown here changed, not on every page event.
  const key = JSON.stringify([profile, tab.slot, tab.proxyParts, tab.proxyKind, tab.timezone, tab.pageZone, otpCodes.get(profile?.id), profile ? 0 : profiles.length]);
  if (details.dataset.key === key) return;
  details.dataset.key = key;
  details.hidden = !profile;
  empty.hidden = Boolean(profile);
  if (!profile) {
    empty.replaceChildren(
      Object.assign(document.createElement('strong'), {
        textContent: profiles.length ? `No profile on tab ${tab.slot}` : 'No profiles yet',
      }),
      Object.assign(document.createElement('span'), {
        textContent: profiles.length ? 'Pick one from the Profile menu above.' : 'Import a CSV or create a profile to get started.',
      }),
    );
    if (!profiles.length) {
      const actions = document.createElement('div');
      actions.className = 'inline';
      actions.append(iconButton('Import CSV', 'import'), iconButton('New profile', 'new'));
      for (const b of actions.children) b.className = '';
      empty.append(actions);
    }
    return;
  }

  // Header: avatar, profile name + email, ⋮ menu.
  const head = document.createElement('div');
  head.className = 'pd-head';
  const title = document.createElement('div');
  title.className = 'pd-title';
  title.append(
    Object.assign(document.createElement('strong'), { textContent: `${profile.favorite ? '★ ' : ''}${profile.profile}` }),
    Object.assign(document.createElement('span'), { textContent: [state.groups?.length > 1 ? groupNameOf(groupOf(profile)) : '', profile.email, profile.site].filter(Boolean).join(' · ') }),
  );
  const more = iconButton('⋮', 'menu', 'More actions');
  head.append(profileAvatar(profile), title, more);

  const unselect = Object.assign(document.createElement('button'), {
    type: 'button', className: 'pd-unselect', textContent: 'Unselect profile',
    title: `Remove ${profile.profile} from tab ${tab.slot}`,
  });
  unselect.dataset.action = 'unselect';

  // Primary actions.
  const actions = document.createElement('div');
  actions.className = 'pd-actions';
  // One fill button: fills the form AND clicks the page's Continue/Save/Login button. Fill-only
  // (review before submitting) stays on the Ctrl/⌘ Shift F shortcut.
  const fill = Object.assign(iconButton('Autofill', 'autofill-submit', "Fill the form and click the page's Continue/Save/Login button (Ctrl/⌘ Shift Enter). Ctrl/⌘ Shift F fills without submitting."), { id: 'autofill', className: 'primary-soft' });
  actions.append(fill);
  if (profile.url) {
    actions.append(Object.assign(iconButton('Auto login', 'auto-login', `Open ${profile.url}, fill the login form and sign in`), { className: '' }));
  }
  if (profile.cards.length > 1) {
    const select = document.createElement('select');
    select.id = 'autofill-card';
    select.setAttribute('aria-label', 'Card to fill');
    select.append(...profile.cards.map((card, i) => new Option(card.last4 ? `Card •••• ${card.last4}` : `Saved card ${i + 1} (CVV only)`, i)));
    const previous = details.querySelector('#autofill-card');
    if (previous && details.dataset.profileId === profile.id) select.value = previous.value;
    actions.append(select);
  }

  // Details.
  const rows = [
    ['Name', profile.name],
    ['Street', profile.address1],
    ['Street 2', profile.address2],
    ['City', profile.city],
    ['State', profile.state],
    ['Zip', profile.zip],
    ['Country', profile.country],
    ['Phone', profile.phone],
    ['SMS Number', profile.smsNumber],
    ['Email', profile.email],
  ].filter(([, value]) => value).map(([label, value]) => detailRow(label, value));
  if (hasPasswordSource(profile)) {
    rows.push(detailRow('Password', '••••••••', { copy: { secret: 'password' }, masked: true }));
  }
  if (hasOtpSource(profile)) {
    const code = otpCodes.get(profile.id) ?? '';
    rows.push(detailRow('OTP Code', code, {
      copy: code,
      extra: [iconButton('↻', 'fetch-otp', 'Watch for the code and fill it into the page automatically when it arrives (also copies it)')],
    }));
  }
  if (profile.dob) rows.push(detailRow('Birthday', profile.dob));
  if (profile.buyer) rows.push(detailRow('Buyer', profile.buyer));
  profile.cards.forEach((card, i) => {
    const n = profile.cards.length > 1 ? ` ${i + 1}` : '';
    rows.push(detailRow(`Card${n}`, card.last4 ? `•••• ${card.last4}` : 'Saved on the account', { copy: card.hasNumber ? { secret: `card.${i}.number` } : '', masked: true }));
    if (card.expMonth) {
      // Expiry is masked like card number and CVV; the copy button pulls the real value via the
      // encrypted-clipboard path, so pasting outside TabSolo shows gibberish.
      rows.push(detailRow(`Expiry${n}`, '••/••', { copy: { secret: `card.${i}.expiry` }, masked: true }));
    }
    rows.push(card.hasCvv
      ? detailRow(`CVV${n}`, '•••', { copy: { secret: `card.${i}.cvv` }, masked: true })
      : detailRow(`CVV${n}`, 'Not saved', { copy: '' }));
  });

  details.replaceChildren(head, unselect, actions, detailHeading('Details'), ...rows);

  if (profile.notes) {
    details.append(detailHeading('Notes'), Object.assign(document.createElement('p'), { className: 'pd-notes', textContent: profile.notes }));
  }

  // The proxy this account is using right now: its pinned start-screen pool proxy, or the local IP.
  const proxy = tab.proxyParts;
  const source = { pinned: 'Pinned from the start-screen pool', direct: 'Local IP' }[tab.proxyKind];
  const heading = detailHeading('Proxy');
  if (source) {
    heading.append(Object.assign(document.createElement('span'), {
      className: `pd-proxy-tag${tab.proxyKind === 'direct' ? '' : ' stable'}`,
      textContent: source,
      title: tab.proxyKind === 'direct' ? '' : 'Kept for this account across restarts, so it keeps a stable IP.',
    }));
  }
  details.append(heading);
  if (proxy) {
    details.append(detailRow('Host', proxy.host), detailRow('Port', String(proxy.port)));
    if (proxy.username) details.append(detailRow('Username', proxy.username));
    if (proxy.hasPassword) details.append(detailRow('Password', '••••••••', { copy: { secret: 'proxyPassword' }, masked: true }));
    if (tab.timezone) {
      details.append(detailRow('Timezone', tab.timezone, { copy: '' }));
      if (tab.pageZone !== tab.timezone) {
        details.append(Object.assign(document.createElement('p'), {
          className: 'pd-notes pd-warning',
          textContent: tab.pageZone
            ? `⚠ This proxy is in ${tab.timezone}, but this tab's clock is ${tab.pageZone}. Reload the tab.`
            : `⚠ This proxy is in ${tab.timezone}, but this tab is still using this computer's clock. Turn on "Set the clock to the proxies' timezone" in Settings.`,
        }));
      }
    }
  } else {
    details.append(Object.assign(document.createElement('p'), { className: 'pd-notes', textContent: 'Local IP — no proxy on this tab.' }));
  }
  details.dataset.profileId = profile.id;
}

function renderProfilePanel(tab) {
  const tabProfile = profiles.find((p) => p.id === tab.profileId) ?? null;
  renderProfileDetails(tabProfile, tab);

  const label = $('.picker-label');
  label.textContent = tabProfile ? tabProfile.profile : 'Profile';
  label.classList.toggle('placeholder', !tabProfile);

  if (!$('#profile-picker-menu').hidden) renderPickerList(tab);
  $('#profile-delete-all').disabled = profiles.length === 0;
  $('#profile-bulk-open').disabled = profiles.length === 0;
}

/** The picker's profile list; built only while the picker is open. */
// ---------- Groups ----------

// The browser works in one group of accounts at a time (state.activeGroup); only its accounts are
// offered anywhere. Changing it happens only through the group dialog, which asks twice.
const groupOf = (p) => p?.group ?? '';
const activeGroupInfo = () => state.groups?.find((g) => g.key === state.activeGroup) ?? null;
const groupNameOf = (key) => state.groups?.find((g) => g.key === key)?.name ?? (key || 'Ungrouped');
const activeProfiles = () => (state.activeGroup === null ? [] : profiles.filter((p) => groupOf(p) === state.activeGroup));

function renderPickerList(tab = selectedTab()) {
  if (!tab) return;
  // The list is about to be rebuilt, so the keyboard cursor resets.
  $('#profile-search').removeAttribute('aria-activedescendant');
  const active = activeGroupInfo();
  const head = $('#picker-group-head');
  head.hidden = !state.groups?.length || (state.groups.length < 2 && Boolean(active));
  if (active) {
    head.style.setProperty('--group-color', active.color);
    $('.picker-group-name').textContent = `${active.name} · ${active.count} account${active.count === 1 ? '' : 's'}`;
  }
  if (!active && profiles.length > 0) {
    $('.picker-group-name').textContent = 'No group chosen';
    const choose = Object.assign(document.createElement('li'), { className: 'hint group-needed' });
    choose.append(
      Object.assign(document.createElement('span'), { textContent: 'Choose the group of accounts you are working in.' }),
      Object.assign(document.createElement('button'), { type: 'button', className: 'primary-soft', textContent: 'Choose group…', id: 'picker-choose-group' }),
    );
    $('#profile-results').replaceChildren(choose);
    return;
  }
  const allMatches = searchProfiles($('#profile-search').value).filter((p) => groupOf(p) === state.activeGroup);
  const matches = allMatches.slice(0, 200);
  const slotsByProfile = new Map();
  for (const t of state.tabs) {
    if (!t.profileId) continue;
    if (!slotsByProfile.has(t.profileId)) slotsByProfile.set(t.profileId, []);
    slotsByProfile.get(t.profileId).push(t.slot);
  }
  $('#profile-results').replaceChildren(...matches.map((p) => {
    const slots = slotsByProfile.get(p.id) ?? [];
    const item = document.createElement('li');
    item.dataset.id = p.id;
    item.id = `po-${p.id}`;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(p.id === tab.profileId));
    item.classList.toggle('active', p.id === tab.profileId);
    const text = document.createElement('div');
    text.className = 'label';
    const name = Object.assign(document.createElement('strong'), { textContent: `${p.favorite ? '★ ' : ''}${p.profile}` });
    // Account-health dot: green=signed in, red=signed out, grey=unknown. Populated by the
    // Profiles → Check All Account Logins action; results live in accountHealthByProfile.
    const health = accountHealthByProfile.get(p.id);
    if (health) {
      const dot = document.createElement('span');
      dot.className = `health-dot health-${health.status}`;
      dot.title = `Health: ${health.status} — ${health.reason || 'click Check All to refresh'}`;
      // Status is shown by colour (green/red/grey); give it a text alternative so it's not colour-only.
      dot.setAttribute('role', 'img');
      dot.setAttribute('aria-label', `Login status: ${health.status}`);
      name.prepend(dot);
    }
    if (slots.length > 0) {
      name.append(Object.assign(document.createElement('span'), {
        className: 'in-use-tag', textContent: slots.length === 1 ? `Tab ${slots[0]}` : `${slots.length} tabs`,
        title: `Assigned to tab${slots.length === 1 ? '' : 's'} ${slots.join(', ')}`,
      }));
    }
    text.append(name, Object.assign(document.createElement('span'), { textContent: p.email ?? '' }));
    item.append(profileAvatar(p), text);
    return item;
  }));
  if (matches.length === 0) {
    $('#profile-results').replaceChildren(Object.assign(document.createElement('li'), {
      className: 'hint',
      textContent: profiles.length ? `No accounts in ${active?.name ?? 'this group'} match.` : 'No profiles yet. Use ⋯ → Import CSV.',
    }));
  } else if (allMatches.length > matches.length) {
    // The list is capped at 200; tell the user the rest are reachable by searching.
    $('#profile-results').append(Object.assign(document.createElement('li'), {
      className: 'hint',
      textContent: `+${allMatches.length - matches.length} more — type to narrow the list.`,
    }));
  }
}

$('#profile-search').addEventListener('input', () => renderPickerList());
window.fleet.onNotice((text) => showNotice(text));
$('#picker-group-head').addEventListener('click', (event) => {
  if (event.target.id !== 'picker-change-group') return;
  event.stopPropagation();
  togglePicker(false);
  openGroupDialog();
});
$('#profile-results').addEventListener('click', (event) => {
  if (event.target.id !== 'picker-choose-group') return;
  event.stopPropagation();
  togglePicker(false);
  openGroupDialog();
}, true);

const profileMenu = $('#profile-menu');
function openProfileMenu(profile, anchor) {
  const rect = anchor.getBoundingClientRect();
  profileMenu.replaceChildren(
    ...(profile.url ? [menuButton('🌐 Open homepage on this tab', 'open-url')] : []),
    menuButton('✏ Edit', 'edit'),
    menuButton(profile.favorite ? '☆ Unstar' : '★ Favorite', 'favorite'),
    menuButton('👯 Duplicate as new profile', 'duplicate'),
    ...(profile.id === selectedTab()?.profileId ? [menuButton('🩺 Check connections', 'check')] : []),
    menuButton('🧹 Clear cookies', 'clear-cookies'),
    menuButton('🗑 Delete', 'delete', true),
  );
  profileMenu.dataset.id = profile.id;
  profileMenu.hidden = false;
  profileMenu.style.top = `${rect.bottom + 2}px`;
  // Panel is now on the left; align the menu's right edge to the button so it stays inside the panel.
  profileMenu.style.left = `${Math.max(8, rect.right - 200)}px`;
  profileMenu.style.right = '';
}
function menuButton(label, action, danger = false) {
  const button = Object.assign(document.createElement('button'), { textContent: label });
  button.dataset.action = action;
  button.className = danger ? 'danger' : '';
  return button;
}
function closeProfileMenu() { profileMenu.hidden = true; }
document.addEventListener('click', (event) => {
  if (!profileMenu.hidden && !event.target.closest('#profile-menu') && event.target.dataset.action !== 'menu') closeProfileMenu();
});

$('#profile-results').addEventListener('click', (event) => {
  const item = event.target.closest('li[data-id]');
  const profile = item && profiles.find((p) => p.id === item.dataset.id);
  if (!profile) return;
  if (pendingSearch) {
    const event = pendingSearch;
    togglePicker(false);
    runEventSearch(event, profile);
    return;
  }
  // Picking a profile assigns it to the current tab and opens its homepage (login page) in its session.
  togglePicker(false);
  command('setProfile', state.selectedId, { profileId: profile.id, url: profile.url || null });
});
$('#profile-results').addEventListener('contextmenu', (event) => {
  const item = event.target.closest('li[data-id]');
  if (!item) return;
  event.preventDefault();
  const profile = profiles.find((p) => p.id === item.dataset.id);
  if (profile) openProfileMenu(profile, item);
});
profileMenu.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const profile = profiles.find((p) => p.id === profileMenu.dataset.id);
  if (!profile) return closeProfileMenu();
  closeProfileMenu();
  const action = button.dataset.action;
  if (action === 'edit') openEditor(profile);
  else if (action === 'check') runCheckConnections();
  else if (action === 'favorite') {
    const result = await window.fleet.saveProfile({ id: profile.id, favorite: !profile.favorite });
    if (result.errors?.length) showNotice(result.errors.join(' '));
  } else if (action === 'open-url' && profile.url) {
    command('setProfile', state.selectedId, { profileId: profile.id, url: profile.url });
  } else if (action === 'clear-cookies' && confirm(`Clear "${profile.profile}"'s cookies? It will be logged out of every site in all its tabs.`)) {
    if (selectedTab()?.profileId !== profile.id) command('setProfile', state.selectedId, profile.id);
    command('clearProfileCookies', state.selectedId);
  } else if (action === 'duplicate') {
    await window.fleet.saveProfile({
      profile: `${profile.profile} copy`, site: profile.site, group: profile.group, name: profile.name,
      email: profile.email, phone: profile.phone, smsNumber: profile.smsNumber,
      address1: profile.address1, address2: profile.address2, city: profile.city, state: profile.state,
      zip: profile.zip, country: profile.country, url: profile.url, favorite: profile.favorite, notes: profile.notes,
    });
    // Secrets (password, cards, resolvers, OTP keys) can't be read in the renderer, so the copy has
    // none — say so rather than letting the user think it can log in.
    showNotice(`Duplicated ${profile.profile}. Re-enter its password, cards and OTP keys — secrets aren't copied.`);
  } else if (action === 'delete' && confirm(`Delete profile "${profile.profile}"? Its logins and site data are deleted too.`)) {
    await window.fleet.deleteProfiles([profile.id]);
    showNotice(`Deleted ${profile.profile}.`);
  }
});

// Jancy-compatible shortcuts.
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === 'KeyP') {
    event.preventDefault();
    setPanelOpen(true);
    togglePicker(true);
  }
  // Ctrl/Cmd + Shift + Enter — one-shot Fill & next (autofill the form, click the primary button).
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === 'Enter') {
    event.preventDefault();
    if (selectedTab()?.profileId) runFillNext();
  }
  // "?" (Shift+/) opens the shortcuts cheat sheet. Ignore when typing in an input.
  if (event.key === '?' && !event.target.matches('input, textarea, [contenteditable]')) {
    event.preventDefault();
    setModal('#shortcuts-sheet', true);
  }
  if (event.key === 'Escape') {
    // Mid-rebind, Esc cancels the key capture (handled on the shortcuts list), not the whole sheet.
    if (capturing) return;
    const open = MODALS.find((selector) => !$(selector).hidden);
    if (open) {
      event.preventDefault();
      setModal(open, false);
    } else {
      // No modal open: Esc also backs out of the profile editor / sheet-import / bulk-assign panels,
      // which are the expected cancel key for those forms.
      const mode = $('#profile-section')?.dataset.mode;
      if (mode === 'editor') { event.preventDefault(); closeEditor(); }
      else if (mode === 'sheet') { event.preventDefault(); closeSheetForm(); }
      else if (mode === 'bulk') { event.preventDefault(); closeBulkAssign(); }
    }
  }
});
// ---------- Dialogs ----------

// Tab pages are drawn above this window's UI, so main hides the page while any dialog is open.
const MODALS = ['#shortcuts-sheet', '#settings-sheet', '#orders-sheet', '#group-sheet', '#seat-test-sheet', '#palette', '#playbooks-sheet', '#recording-review-sheet'];
let modalOpener = null;
function setModal(selector, open) {
  const el = $(selector);
  if (open && el.hidden) modalOpener = document.activeElement;
  el.hidden = !open;
  window.fleet.setOverlay(MODALS.some((s) => !$(s).hidden));
  // Move focus into the dialog on open (the page behind is hidden, so a stranded focus is a dead
  // keyboard), and hand it back to whatever opened it on close. A caller that wants a specific
  // field focused still runs after this and wins.
  if (open) {
    const focusable = el.querySelector('input:not([disabled]), button:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])');
    (focusable || el).focus?.();
  } else if (typeof modalOpener?.focus === 'function') {
    modalOpener.focus();
    modalOpener = null;
  }
}
$('#shortcuts-close').addEventListener('click', () => setModal('#shortcuts-sheet', false));
$('#help-btn').addEventListener('click', openShortcutsSheet);

// Shortcuts sheet: rich, grouped, editable. Each row shows the label + description + current
// accelerator. Clicking the accelerator turns the chip into a "listening…" box; press any key
// combo and we save it, Esc cancels, Delete clears to the default.
let shortcutsData = { actions: [], current: {}, defaults: {}, overrides: {} };
let capturing = null; // { id, chip }

async function openShortcutsSheet() {
  shortcutsData = await window.fleet.getShortcuts();
  renderShortcutsSheet();
  setModal('#shortcuts-sheet', true);
}
function renderShortcutsSheet() {
  const list = $('#shortcuts-list');
  if (!list) return;
  const { actions, current, defaults, overrides } = shortcutsData;
  const groups = {};
  for (const a of actions) (groups[a.group] ||= []).push(a);
  list.replaceChildren(...Object.entries(groups).map(([groupName, acts]) => {
    const section = document.createElement('section');
    section.className = 'shortcut-group';
    section.append(Object.assign(document.createElement('h4'), { textContent: groupName }));
    for (const act of acts) {
      const row = document.createElement('div');
      row.className = 'shortcut-row';
      const label = document.createElement('div');
      label.className = 'shortcut-label';
      label.append(
        Object.assign(document.createElement('strong'), { textContent: act.label }),
        Object.assign(document.createElement('span'), { textContent: act.description || '' }),
      );
      const chip = document.createElement('button');
      chip.className = 'shortcut-chip';
      chip.textContent = formatAccelerator(current[act.id] || defaults[act.id]);
      chip.dataset.actionId = act.id;
      // Static-scope rows (modifier variants like Shift-click, drag) aren't rebindable.
      if (act.scope === 'renderer' && /inside|address bar/.test(current[act.id] || '')) {
        chip.disabled = true;
        chip.classList.add('readonly');
      }
      if (overrides[act.id]) chip.classList.add('customized');
      row.append(label, chip);
      section.append(row);
    }
    return section;
  }));
}
function formatAccelerator(a) {
  if (!a) return 'None';
  return a
    .replace(/CmdOrCtrl/g, navigator.platform.includes('Mac') ? '⌘' : 'Ctrl')
    .replace(/Cmd/g, '⌘').replace(/Ctrl/g, 'Ctrl')
    .replace(/Shift/g, '⇧').replace(/Alt/g, navigator.platform.includes('Mac') ? '⌥' : 'Alt')
    .replace(/\+/g, ' ');
}

$('#shortcuts-list')?.addEventListener('click', (event) => {
  const chip = event.target.closest('.shortcut-chip');
  if (!chip || chip.disabled) return;
  if (capturing) capturing.chip.classList.remove('capturing');
  capturing = { id: chip.dataset.actionId, chip };
  chip.classList.add('capturing');
  chip.textContent = 'Press a key…';
  chip.focus();
});
window.addEventListener('keydown', async (event) => {
  if (!capturing) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    const prev = shortcutsData.current[capturing.id] || shortcutsData.defaults[capturing.id];
    capturing.chip.textContent = formatAccelerator(prev);
    capturing.chip.classList.remove('capturing');
    capturing = null;
    return;
  }
  // Delete clears the override — restore the default.
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    const result = await window.fleet.setShortcut(capturing.id, '');
    if (result?.current) shortcutsData.current = result.current;
    delete shortcutsData.overrides[capturing.id];
    capturing.chip.classList.remove('capturing', 'customized');
    renderShortcutsSheet();
    capturing = null;
    return;
  }
  // Modifier-only keystrokes are a no-op — wait for a real key.
  if (['Shift', 'Control', 'Meta', 'Alt'].includes(event.key)) return;
  event.preventDefault();
  const parts = [];
  if (event.metaKey || event.ctrlKey) parts.push('CmdOrCtrl');
  if (event.shiftKey) parts.push('Shift');
  if (event.altKey) parts.push('Alt');
  // Normalise letters: 'a' → 'A', punctuation stays as is; function keys use 'F1' etc.
  let key = event.key;
  if (key.length === 1) key = key.toUpperCase();
  else if (/^f\d+$/i.test(key)) key = key.toUpperCase();
  parts.push(key);
  const accel = parts.join('+');
  const result = await window.fleet.setShortcut(capturing.id, accel);
  if (result?.error) {
    showNotice(result.error);
  } else {
    shortcutsData.current = result.current;
    shortcutsData.overrides[capturing.id] = accel;
    renderShortcutsSheet();
  }
  capturing = null;
});

$('#shortcuts-reset')?.addEventListener('click', async () => {
  if (!confirm('Restore every shortcut to its default?')) return;
  const result = await window.fleet.resetShortcuts();
  if (result?.current) {
    shortcutsData.current = result.current;
    shortcutsData.overrides = {};
    renderShortcutsSheet();
    showNotice('Shortcuts restored to defaults.');
  }
});

window.fleet.onShortcutsChanged?.(({ accelerators }) => {
  shortcutsData.current = accelerators;
  if (!$('#shortcuts-sheet').hidden) renderShortcutsSheet();
});

// Recording + Playbooks panel — one modal that acts as the home for everything related to
// capture and replay. Opens on 📜 Playbooks click (or the toolbar Record button also surfaces
// it after a stop). Live-updates to the recording state whenever onState fires, so the Start/Stop
// button in the panel always matches reality.
async function openPlaybooks() {
  // Open the modal FIRST so the user always sees it, then populate. If anything in the list
  // fetch throws, we still render the recording panel and show the empty state instead of silently
  // doing nothing.
  renderRecordingPanel();
  setModal('#playbooks-sheet', true);
  try { await renderPlaybooks(); } catch (error) {
    const list = $('#playbooks-list');
    if (list) list.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'shortcuts-hint',
      textContent: `Could not load playbooks: ${error?.message || error}`,
    }));
  }
}
function renderRecordingPanel() {
  const indicator = $('#recording-indicator');
  const title = $('#recording-title');
  const sub = $('#recording-sub');
  const toggle = $('#recording-toggle');
  if (!indicator) return;
  if (state.recording) {
    indicator.classList.add('active');
    title.textContent = `Recording … ${state.recordedCount ?? 0} action${(state.recordedCount ?? 0) === 1 ? '' : 's'} captured`;
    sub.textContent = 'Every click, input and navigation across all tabs is being saved. Click Stop to save as a playbook.';
    toggle.textContent = 'Stop recording';
    toggle.classList.remove('primary');
    toggle.classList.add('burn');
  } else {
    indicator.classList.remove('active');
    title.textContent = 'Not recording';
    sub.textContent = 'Click Start to capture a flow across all tabs. Stop to save it as a playbook.';
    toggle.textContent = 'Start recording';
    toggle.classList.add('primary');
    toggle.classList.remove('burn');
  }
}
async function renderPlaybooks() {
  const list = $('#playbooks-list');
  if (!list) return;
  const items = await window.fleet.listPlaybooks();
  if (!items || items.length === 0) {
    list.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'shortcuts-hint',
      textContent: 'No playbooks yet. Click Start recording, do a flow, then Stop to save your first.',
    }));
    return;
  }
  list.replaceChildren(...items.map((p) => {
    const row = document.createElement('div');
    row.className = 'playbook-row';
    const info = document.createElement('div');
    info.className = 'playbook-info';
    info.append(
      Object.assign(document.createElement('strong'), { textContent: p.name }),
      Object.assign(document.createElement('span'), {
        textContent: `${p.actionCount} action${p.actionCount === 1 ? '' : 's'} · ${new Date(p.createdAt).toLocaleString()}${p.hostPatterns.length ? ` · ${p.hostPatterns.join(', ')}` : ''}`,
      }),
    );
    const run = Object.assign(document.createElement('button'), { className: 'primary-soft', textContent: '▶ Run on current tab' });
    run.dataset.runId = p.id;
    const rename = Object.assign(document.createElement('button'), { textContent: 'Rename' });
    rename.dataset.renameId = p.id;
    rename.dataset.currentName = p.name;
    const del = Object.assign(document.createElement('button'), { className: 'icon', textContent: '🗑', title: 'Delete playbook' });
    del.dataset.deleteId = p.id;
    row.append(info, run, rename, del);
    return row;
  }));
}
$('#playbooks-open')?.addEventListener('click', openPlaybooks);
$('#playbooks-close')?.addEventListener('click', () => setModal('#playbooks-sheet', false));
$('#recording-toggle')?.addEventListener('click', () => recordBtn.click()); // reuse the toolbar handler
$('#playbooks-list')?.addEventListener('click', async (event) => {
  const runId = event.target.closest('[data-run-id]')?.dataset.runId;
  if (runId) {
    const targetURL = $('#playbook-target-url').value.trim();
    // Build an order-like object from the input fields. Any field left blank falls back to the
    // playbook's recorded value for that step.
    const low = Number($('#playbook-low-seat').value) || null;
    const high = Number($('#playbook-high-seat').value) || low || null;
    const order = {
      section: $('#playbook-section').value.trim() || null,
      row: $('#playbook-row').value.trim() || null,
      lowSeat: low,
      highSeat: high,
      low_seat: low,
      high_seat: high,
      quantity: Number($('#playbook-qty').value) || null,
    };
    // Branch:
    //  - URL given → open a NEW tab at that URL, run the playbook once it loads.
    //  - URL blank → run on the currently focused tab.
    if (targetURL) {
      const result = await window.fleet.runPlaybookOnURL({ url: targetURL, playbookId: runId, order });
      if (result?.error) { showNotice(result.error); return; }
      setModal('#playbooks-sheet', false);
      showNotice(`Opened ${targetURL} and started the playbook.`);
      $('#playbook-target-url').value = '';
      return;
    }
    const tab = selectedTab();
    if (!tab) { showNotice('Select a tab first, or enter an Event URL.'); return; }
    // If the tab already has an attached order from the Orders panel, prefer any blanks from the
    // form falling back to that; otherwise the form fields win.
    const tabOrder = tab.orderId ? orderState.orders.find((o) => String(o.id) === String(tab.orderId)) : null;
    const merged = tabOrder ? { ...tabOrder, ...Object.fromEntries(Object.entries(order).filter(([, v]) => v != null)) } : order;
    const result = await window.fleet.runPlaybook({ tabId: tab.id, playbookId: runId, order: merged });
    if (result?.error) showNotice(result.error);
    else { setModal('#playbooks-sheet', false); showNotice('Playbook started on the current tab.'); }
    return;
  }
  const renameBtn = event.target.closest('[data-rename-id]');
  if (renameBtn) {
    const id = renameBtn.dataset.renameId;
    const current = renameBtn.dataset.currentName || '';
    // Inline rename: swap the strong element for an input, bind Enter / Esc.
    const row = renameBtn.closest('.playbook-row');
    const strong = row.querySelector('.playbook-info strong');
    const input = Object.assign(document.createElement('input'), { type: 'text', value: current, className: 'playbook-rename-input' });
    strong.replaceWith(input);
    input.focus();
    input.select();
    let committed = false;
    const commit = async (save) => {
      // Enter/Escape commits remove the input from the DOM, which fires blur and would call
      // commit a second time. The flag collapses that into one call.
      if (committed) return;
      committed = true;
      const next = input.value.trim();
      if (save && next && next !== current) {
        const result = await window.fleet.renamePlaybook({ id, name: next });
        if (result?.error) showNotice(result.error);
        else await renderPlaybooks();
      } else {
        await renderPlaybooks();
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit(true);
      else if (e.key === 'Escape') commit(false);
    });
    input.addEventListener('blur', () => commit(true));
    return;
  }
  const deleteId = event.target.closest('[data-delete-id]')?.dataset.deleteId;
  if (deleteId) {
    if (!confirm('Delete this playbook? Cannot be undone.')) return;
    await window.fleet.deletePlaybook(deleteId);
    renderPlaybooks();
  }
});

// Live playbook-progress toasts (coalesced).
window.fleet.onPlaybookProgress?.((info) => {
  if (info.status === 'done') showNotice(`Playbook completed (${info.step} steps).`);
  else if (info.status === 'miss') showNotice(`Playbook step ${info.step}: target missing — ${info.detail || ''}`, 8000);
  else if (info.status === 'error') showNotice(`Playbook step ${info.step}: ${info.detail || 'error'}`, 8000);
});

// Developer test harness for the Ticketmaster seat matcher. Two paths from this modal:
//   - "Inject into current tab" — reuses the current tab, assumes you're already on a TM event page.
//   - "Open full flow in new tab" — opens the TM search for the given event name/date in a NEW tab
//     and attaches the payload, so when you click into the right event the overlay fires on its own.
// Auto-click flag drives whether the overlay auto-presses the first match + add-to-cart (test-only).
function openSeatTest() {
  setModal('#seat-test-sheet', true);
  $('#seat-test-form').elements.eventName.focus();
  $('#seat-test-status').textContent = '';
}
function readSeatTestPayload() {
  const form = $('#seat-test-form');
  const payload = {
    eventName: form.elements.eventName.value.trim(),
    occursAt: form.elements.occursAt.value.trim(),
    quantity: Number(form.elements.quantity.value) || null,
    section: form.elements.section.value.trim(),
    row: form.elements.row.value.trim(),
    lowSeat: Number(form.elements.lowSeat.value) || null,
    highSeat: Number(form.elements.highSeat.value) || null,
    autoClick: $('#seat-test-autoclick').checked,
  };
  if (payload.lowSeat && !payload.highSeat) payload.highSeat = payload.lowSeat;
  return payload;
}
$('#seat-test-close').addEventListener('click', () => setModal('#seat-test-sheet', false));
$('#seat-test-cancel').addEventListener('click', () => setModal('#seat-test-sheet', false));
$('#seat-test-inject').addEventListener('click', async () => {
  const payload = readSeatTestPayload();
  if (!payload.section && !payload.row && !payload.lowSeat) {
    $('#seat-test-status').textContent = 'Give at least one of section, row, or low seat.';
    return;
  }
  const result = await window.fleet.testSeatMatch(payload);
  if (result?.error) {
    $('#seat-test-status').textContent = result.error;
    return;
  }
  setModal('#seat-test-sheet', false);
  showNotice('Seat matcher injected. Watch the top-right banner on the current tab.');
});
$('#seat-test-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = readSeatTestPayload();
  if (!payload.eventName) {
    $('#seat-test-status').textContent = 'Enter an event name to open the full flow.';
    return;
  }
  const result = await window.fleet.testSeatMatchFlow(payload);
  if (result?.error) {
    $('#seat-test-status').textContent = result.error;
    return;
  }
  setModal('#seat-test-sheet', false);
  showNotice(`Opened Ticketmaster search for "${payload.eventName}". Click into the event — the overlay will fire.`);
});
window.fleet.onOpenSeatTest(openSeatTest);
$('#seat-test-open').addEventListener('click', openSeatTest);

// Recorder toolbar button. Label + style updates come from render() reading state.recording.
const recordBtn = $('#record-toggle');
recordBtn.addEventListener('click', async () => {
  if (state.recording) {
    // Stop without a name so main returns the captured actions. The user reviews them (uncheck
    // steps, insert waits), then clicks Save in the review modal. The raw file main dumps along
    // the way is the backup if the user Cancels.
    const orderContext = selectedTab()?.orderId
      ? orderState.orders.find((o) => String(o.id) === String(selectedTab().orderId))
      : null;
    const result = await window.fleet.stopRecording({ orderContext });
    if (!result || result.count === 0) {
      showNotice('Nothing was recorded.');
      return;
    }
    openRecordingReview(result.actions || [], orderContext);
  } else {
    await window.fleet.startRecording();
    showNotice('Recording. Click Stop when you’re done — you’ll get a chance to prune steps.', 6000);
  }
});
// Review modal: let the user prune steps and insert waits before the recording becomes a playbook.
// Model: { action, keep } rows. 'wait' rows carry { action: { type: 'wait', ms }, keep: true }.
let reviewRows = [];
let reviewOrderContext = null;
function openRecordingReview(actions, orderContext) {
  reviewRows = actions.map((action) => ({ action, keep: true }));
  reviewOrderContext = orderContext;
  $('#recording-review-name').value = `Playbook ${new Date().toLocaleString()}`;
  renderReviewList();
  setModal('#recording-review-sheet', true);
}
function reviewLabel(action) {
  if (action.type === 'wait') return `${action.ms}ms pause`;
  const el = action.el || {};
  const bits = [el.text, el.attrs?.['aria-label'], el.attrs?.name, el.attrs?.placeholder, action.url, action.key]
    .filter(Boolean).map((v) => String(v).slice(0, 60));
  if (action.type === 'input' || action.type === 'change') bits.unshift(action.value ? `“${String(action.value).slice(0, 40)}”` : '(blank)');
  return bits[0] || el.tag || action.type;
}
function renderReviewList() {
  const list = $('#recording-review-list');
  list.replaceChildren();
  reviewRows.forEach((row, index) => {
    // Insertion button before every row (and one at the end below) so the user can drop a wait
    // anywhere in the sequence.
    const insert = document.createElement('div');
    insert.className = 'review-insert';
    const btn = Object.assign(document.createElement('button'), { textContent: '+ wait' });
    btn.addEventListener('click', () => {
      reviewRows.splice(index, 0, { action: { type: 'wait', ms: 500 }, keep: true });
      renderReviewList();
    });
    insert.append(btn);
    list.append(insert);

    const el = document.createElement('div');
    el.className = `review-row${row.keep ? '' : ' disabled'}${row.action.type === 'wait' ? ' wait' : ''}`;
    const check = Object.assign(document.createElement('input'), { type: 'checkbox', checked: row.keep });
    check.addEventListener('change', () => { row.keep = check.checked; renderReviewList(); });
    const kind = Object.assign(document.createElement('span'), { className: 'kind', textContent: row.action.type });
    el.append(check, kind);
    if (row.action.type === 'wait') {
      const ms = Object.assign(document.createElement('input'), { type: 'number', min: '0', max: '60000', step: '100', value: String(row.action.ms) });
      ms.addEventListener('input', () => { row.action.ms = Math.max(0, Math.min(60000, Number(ms.value) || 0)); });
      const label = Object.assign(document.createElement('span'), { className: 'label', textContent: 'ms' });
      el.append(ms, label);
    } else {
      const label = Object.assign(document.createElement('span'), { className: 'label', textContent: reviewLabel(row.action) });
      el.append(label);
    }
    list.append(el);
  });
  const tail = document.createElement('div');
  tail.className = 'review-insert';
  const tailBtn = Object.assign(document.createElement('button'), { textContent: '+ wait' });
  tailBtn.addEventListener('click', () => {
    reviewRows.push({ action: { type: 'wait', ms: 500 }, keep: true });
    renderReviewList();
  });
  tail.append(tailBtn);
  list.append(tail);
}
$('#recording-review-close')?.addEventListener('click', () => setModal('#recording-review-sheet', false));
$('#recording-review-cancel')?.addEventListener('click', () => {
  setModal('#recording-review-sheet', false);
  showNotice('Recording not saved. The raw backup is in TabSolo’s data folder.', 6000);
});
$('#recording-review-save')?.addEventListener('click', async () => {
  const name = $('#recording-review-name').value.trim();
  if (!name) { showNotice('Give the playbook a name.'); return; }
  const actions = reviewRows.filter((r) => r.keep).map((r) => r.action);
  if (actions.length === 0) { showNotice('Nothing to save — every step is unchecked.'); return; }
  const result = await window.fleet.saveLastRecordingAsPlaybook({ name, orderContext: reviewOrderContext, actions });
  if (result?.error) { showNotice(result.error); return; }
  setModal('#recording-review-sheet', false);
  showNotice(`Saved playbook "${result.playbook.name}" with ${result.playbook.actions.length} actions.`, 6000);
  openPlaybooks();
});

function renderRecorderButton() {
  if (state.recording) {
    recordBtn.textContent = `⏹ Stop (${state.recordedCount ?? 0})`;
    recordBtn.style.background = '#c91c1c';
    recordBtn.style.color = '#fff';
    recordBtn.style.borderColor = '#c91c1c';
  } else {
    recordBtn.textContent = '🔴 Record';
    recordBtn.style.background = '';
    recordBtn.style.color = '';
    recordBtn.style.borderColor = '';
  }
}
for (const selector of MODALS) {
  // Clicking the backdrop closes.
  $(selector).addEventListener('click', (event) => {
    if (event.target === $(selector)) setModal(selector, false);
  });
}

try {
  const saved = localStorage.getItem('theme');
  if (saved) applyTheme(saved);
} catch {}

// ---------- Settings & updates ----------

let updateInfo = { version: '', supported: false, settings: { autoDownload: true, notifyUpdates: true }, status: { kind: 'idle' }, lastChecked: null };
let bannerDismissedFor = null;

function describeUpdate({ status, supported, settings }) {
  switch (status.kind) {
    case 'unsupported': return "Updates are only available in the installed app.";
    case 'checking': return 'Checking for updates…';
    case 'up-to-date': return "You're on the latest version.";
    case 'available': return settings.autoDownload || status.downloading
      ? `Version ${status.version} is available — downloading…`
      : `Version ${status.version} is available.`;
    case 'progress': return `Downloading ${status.version ? `version ${status.version}` : 'update'} — ${status.percent}%`;
    case 'downloaded': return `Version ${status.version} is ready. Restart to install — your profiles and tabs are kept.`;
    case 'error': return `Couldn't check for updates: ${status.message}`;
    default: return supported ? 'Checks automatically every 2 hours.' : '';
  }
}

function renderUpdates() {
  const { status, supported, settings, version, lastChecked } = updateInfo;
  $('#app-version').textContent = version;
  const stateEl = $('#update-state');
  stateEl.textContent = describeUpdate(updateInfo);
  stateEl.classList.toggle('error', status.kind === 'error');
  stateEl.classList.toggle('ok', status.kind === 'up-to-date' || status.kind === 'downloaded');
  const progress = $('#update-progress');
  progress.hidden = status.kind !== 'progress';
  progress.value = status.percent ?? 0;
  const canDownload = status.kind === 'available' && !settings.autoDownload && !status.downloading;
  $('#settings-download').hidden = !canDownload;
  $('#settings-install').hidden = status.kind !== 'downloaded';
  const check = $('#settings-check');
  check.disabled = !supported || ['checking', 'progress'].includes(status.kind);
  check.hidden = status.kind === 'downloaded';
  check.textContent = status.kind === 'checking' ? 'Checking…' : 'Check for updates';
  $('#setting-notify').checked = settings.notifyUpdates;
  $('#setting-autodownload').checked = settings.autoDownload;
  $('#setting-match-tz').checked = settings.matchProxyTimezone !== false;
  $('#setting-auto-open-orders').checked = settings.autoOpenOrders === true;
  $('#update-checked').textContent = lastChecked ? `Last checked ${new Date(lastChecked).toLocaleString()}` : '';

  // Banner under the toolbar: only for news worth acting on, and only when notifications are on.
  // A check the user started from Settings reports there instead.
  const key = `${status.kind}:${status.version ?? ''}`;
  const news = (status.kind === 'downloaded') || (status.kind === 'available' && canDownload)
    || (['available', 'progress'].includes(status.kind) && settings.notifyUpdates && !status.manual);
  const banner = $('#update-banner');
  banner.hidden = !settings.notifyUpdates || !news || bannerDismissedFor === key
    || (status.kind === 'progress' && bannerDismissedFor === `available:${status.version ?? ''}`);
  $('#update-text').textContent = describeUpdate(updateInfo);
  $('#update-download').hidden = !canDownload;
  $('#update-install').hidden = status.kind !== 'downloaded';
}

async function openSettings() {
  $('#setting-theme').value = document.documentElement.dataset.theme ?? 'system';
  renderSyncSettings();
  updateInfo = await window.fleet.getUpdateInfo();
  renderUpdates();
  setModal('#settings-sheet', true);
  renderLicense();
  $('#settings-close').focus();
}

window.fleet.onUpdateStatus((info) => {
  updateInfo = info;
  renderUpdates();
});
window.fleet.onOpenSettings(openSettings);
$('#settings-open').addEventListener('click', openSettings);
$('#launcher-settings').addEventListener('click', openSettings);
$('#settings-close').addEventListener('click', () => setModal('#settings-sheet', false));
async function renderLicense() {
  const { key } = await window.fleet.getLicenseInfo();
  $('#license-group').hidden = !key;
  $('#license-key').textContent = key ?? '';
}
$('#license-deactivate').addEventListener('click', async () => {
  if (!confirm('Deactivate TabSolo on this computer?\n\nAll tabs close and TabSolo restarts. You can activate here again with your license key.')) return;
  const button = $('#license-deactivate');
  button.disabled = true;
  const result = await window.fleet.deactivateLicense();
  if (result.ok) return;
  button.disabled = false;
  showNotice(result.error === 'network_error' || result.error === 'TypeError' || result.error === 'AbortError'
    ? 'Can’t reach the license server, so this computer is still active. Check your connection and try again.'
    : `Could not deactivate: ${result.error}`, 6000);
});
$('#settings-check').addEventListener('click', async () => {
  updateInfo = { ...updateInfo, status: { kind: 'checking', manual: true } };
  renderUpdates();
  try {
    updateInfo = await window.fleet.checkForUpdate();
  } catch {
    // Don't leave the button stuck on "Checking…" and disabled if the call rejects.
    updateInfo = { ...updateInfo, status: { kind: 'idle' } };
    showNotice('Update check failed. Check your connection and try again.', 6000);
  }
  renderUpdates();
});
const downloadUpdate = async () => {
  updateInfo = await window.fleet.downloadUpdate();
  renderUpdates();
};
$('#settings-download').addEventListener('click', downloadUpdate);
$('#update-download').addEventListener('click', downloadUpdate);
$('#settings-install').addEventListener('click', () => window.fleet.installUpdate());
$('#update-install').addEventListener('click', () => window.fleet.installUpdate());
$('#update-dismiss').addEventListener('click', () => {
  const { status } = updateInfo;
  bannerDismissedFor = `${status.kind}:${status.version ?? ''}`;
  renderUpdates();
});
for (const [selector, key] of [['#setting-notify', 'notifyUpdates'], ['#setting-autodownload', 'autoDownload'], ['#setting-match-tz', 'matchProxyTimezone'], ['#setting-auto-open-orders', 'autoOpenOrders']]) {
  $(selector).addEventListener('change', async (event) => {
    updateInfo = await window.fleet.saveSettings({ [key]: event.target.checked });
    renderUpdates();
  });
}
$('#setting-theme').addEventListener('change', (event) => {
  applyTheme(event.target.value);
  try { localStorage.setItem('theme', event.target.value); } catch {}
});
window.fleet.getUpdateInfo().then((info) => {
  updateInfo = info;
  renderUpdates();
});

// ---------- Automatiq Sync: settings ----------

const syncForm = $('#sync-form');
async function renderSyncSettings(info) {
  info ??= await window.fleet.getSyncSettings();
  syncForm.elements.companyId.value = info.companyId;
  syncForm.elements.apiToken.value = '';
  syncForm.elements.apiToken.placeholder = info.hasToken ? 'Saved — paste a new token to replace it' : 'Paste your Sync API token';
  $('#sync-clear').hidden = !info.hasToken;
  const status = $('#sync-status');
  status.classList.remove('ok', 'error');
  status.textContent = info.source === 'settings' ? 'Connected with your saved credentials.'
    : info.source === 'env' ? 'Using development credentials from .env.local until you save your own.'
      : 'Not set up yet.';
}
async function saveSync(extra = {}) {
  const result = await window.fleet.saveSyncSettings({
    companyId: syncForm.elements.companyId.value,
    apiToken: syncForm.elements.apiToken.value,
    ...extra,
  });
  if (result.error) {
    $('#sync-status').textContent = result.error;
    $('#sync-status').classList.add('error');
    return false;
  }
  await renderSyncSettings(result);
  if (result.warning) $('#sync-status').textContent = result.warning;
  return true;
}
syncForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (await saveSync()) $('#sync-status').textContent = 'Saved.';
});
$('#sync-clear').addEventListener('click', () => saveSync({ apiToken: '', clearToken: true }));
$('#sync-test').addEventListener('click', async () => {
  const status = $('#sync-status');
  // Save first so the test uses what's typed.
  if ((syncForm.elements.companyId.value || syncForm.elements.apiToken.value) && !(await saveSync())) return;
  status.classList.remove('ok', 'error');
  status.textContent = 'Testing…';
  const result = await window.fleet.testSync();
  status.classList.add(result.error ? 'error' : 'ok');
  status.textContent = result.error ?? `Connected — ${result.count.toLocaleString()} orders on your account.`;
});

// ---------- Automatiq Sync: orders ----------

// The Orders screen shows just the newest invoiced orders — the sales still waiting to be filled.
const RECENT_INVOICED = { status: 'invoiced', limit: 25, page: 1, orderBy: 'created_at', direction: 'desc' };
// Default filter: hide orders the rep has already handled, so the queue only shows actionable work.
const orderState = { orders: [], selected: null, loading: false, request: 0, filter: 'open' };
const titleCase = (text) => String(text ?? '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const shortDateTime = (value) => {
  if (!value) return '';
  const [date, time = ''] = String(value).split('T');
  return time ? `${date} ${time.slice(0, 5)}` : date;
};
const parseApiDate = (value) => (value ? new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`) : null);
// Event dates are local to the venue, so show them as written rather than converting time zones.
const eventDate = (value) => {
  if (!value) return '';
  const [date, time = ''] = String(value).split('T');
  const d = new Date(`${date}T00:00:00`);
  const day = Number.isNaN(d.getTime()) ? date : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  if (!time) return day;
  const [h, m] = time.split(':').map(Number);
  return `${day} · ${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
const untilEvent = (value) => {
  if (!value) return '';
  const days = Math.round((new Date(`${String(value).slice(0, 10)}T00:00:00`) - new Date(new Date().toDateString())) / 864e5);
  if (Number.isNaN(days)) return '';
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return days > 0 ? `In ${days} days` : `${-days} days ago`;
};
const relativeAge = (value) => {
  const d = parseApiDate(value);
  if (!d || Number.isNaN(d.getTime())) return shortDateTime(value);
  const minutes = Math.round((Date.now() - d.getTime()) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
const money = (value) => (value === null || value === undefined || value === '' ? '' : `$${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const seatsOf = (o) => [
  o.section && `Sec ${o.section}`,
  o.row && `Row ${o.row}`,
  o.low_seat && (o.high_seat && o.high_seat !== o.low_seat ? `Seats ${o.low_seat}–${o.high_seat}` : `Seat ${o.low_seat}`),
].filter(Boolean).join(' · ');

function statusPill(status) {
  return Object.assign(document.createElement('span'), { className: `status-pill s-${status ?? 'unknown'}`, textContent: titleCase(status ?? 'unknown') });
}

async function loadOrders() {
  const request = ++orderState.request;
  orderState.loading = true;
  renderOrders();
  const result = await window.fleet.listOrders(RECENT_INVOICED);
  if (request !== orderState.request) return; // a newer refresh replaced this one
  orderState.loading = false;
  orderState.error = result.error ?? null;
  orderState.needsSetup = Boolean(result.needsSetup);
  orderState.orders = result.orders ?? [];
  if (!orderState.orders.some((o) => o.id === orderState.selected?.id)) orderState.selected = null;
  renderOrders();
}

// Renders the status filter row at the top of the orders panel. Keeps the counts live so the rep
// sees "6 new" and "3 handled" instead of having to switch filters to find out.
function renderOrderFilterBar() {
  const bar = $('#orders-filter');
  if (!bar) return;
  const counts = { all: orderState.orders.length, open: 0, new: 0, working: 0, handled: 0 };
  for (const o of orderState.orders) {
    const s = o.localStatus ?? 'new';
    counts[s]++;
    if (s !== 'handled') counts.open++;
  }
  const buttons = [
    { key: 'open', label: 'Open', count: counts.open },
    { key: 'new', label: 'New', count: counts.new },
    { key: 'working', label: 'Working', count: counts.working },
    { key: 'handled', label: 'Handled', count: counts.handled },
    { key: 'all', label: 'All', count: counts.all },
  ];
  bar.replaceChildren(...buttons.map((b) => {
    const btn = document.createElement('button');
    btn.className = `order-filter s-${b.key}${orderState.filter === b.key ? ' active' : ''}`;
    btn.textContent = `${b.label} ${b.count}`;
    btn.dataset.filter = b.key;
    return btn;
  }));
}

// Applies the orderState.filter (All / Open / New / Working / Handled) to the fetched list before
// rendering. 'Open' hides handled orders — the default so the queue only shows actionable work.
function visibleOrders() {
  const { orders, filter } = orderState;
  if (filter === 'all') return orders;
  if (filter === 'open') return orders.filter((o) => (o.localStatus ?? 'new') !== 'handled');
  return orders.filter((o) => (o.localStatus ?? 'new') === filter);
}

function renderOrders() {
  const { loading, error } = orderState;
  renderOrderFilterBar();
  const orders = visibleOrders();
  const tbody = $('#orders-table tbody');
  tbody.replaceChildren(...orders.map((o) => {
    const row = document.createElement('tr');
    row.dataset.id = o.id;
    row.classList.toggle('selected', o.id === orderState.selected?.id);
    row.classList.add(`order-${o.localStatus ?? 'new'}`);
    const cell = (text, className = '') => Object.assign(document.createElement('td'), { textContent: text ?? '', className });
    // Dedicated narrow cell for the status dot so it stays vertically centered with the row and
    // doesn't push the Ordered column's stack onto a second line.
    const dotCell = document.createElement('td');
    dotCell.className = 'order-dot-cell';
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = `order-dot s-${o.localStatus ?? 'new'}`;
    dot.title = `Status: ${titleCase(o.localStatus ?? 'new')} — click to cycle`;
    dot.dataset.statusToggle = o.id;
    dot.setAttribute('aria-label', `Status: ${o.localStatus ?? 'new'}`);
    dotCell.append(dot);
    const ordered = document.createElement('td');
    ordered.className = 'stack';
    ordered.append(
      Object.assign(document.createElement('strong'), { textContent: relativeAge(o.order_date) }),
      Object.assign(document.createElement('span'), { className: 'mono', textContent: `#${o.order_id ?? ''}` }),
    );
    const event = document.createElement('td');
    event.className = 'event';
    event.append(
      Object.assign(document.createElement('strong'), { textContent: o.event_name ?? '' }),
      Object.assign(document.createElement('span'), { textContent: [o.venue_name, [o.city, o.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ') }),
    );
    const when = document.createElement('td');
    when.className = 'stack';
    when.append(
      Object.assign(document.createElement('strong'), { textContent: eventDate(o.occurs_at) }),
      Object.assign(document.createElement('span'), { textContent: untilEvent(o.occurs_at) }),
    );
    const action = document.createElement('td');
    const search = Object.assign(document.createElement('button'), {
      className: 'search-event', textContent: 'Search', title: `Search “${o.event_name ?? ''}” on Ticketmaster`, disabled: !o.event_name,
    });
    search.dataset.search = o.id;
    const done = Object.assign(document.createElement('button'), {
      className: 'order-handled-btn',
      textContent: o.localStatus === 'handled' ? '↩︎ Reopen' : '✓ Done',
      title: o.localStatus === 'handled' ? 'Mark this order as new again' : 'Mark this order as handled',
    });
    done.dataset.markHandled = o.id;
    action.append(search, done);
    const marketplace = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = `marketplace-pill mp-${(o.marketplace || 'unknown').replace(/[^a-z0-9_]/gi, '-').toLowerCase()}`;
    pill.textContent = titleCase(o.marketplace || 'unknown');
    marketplace.append(pill);
    row.append(
      dotCell, ordered, event, when, cell(seatsOf(o)), cell(o.quantity, 'num'), cell(money(o.total), 'num'),
      marketplace, action,
    );
    return row;
  }));
  const empty = $('#orders-empty');
  empty.hidden = orders.length > 0 && !error;
  empty.classList.toggle('error', Boolean(error));
  empty.replaceChildren();
  if (error) {
    empty.append(Object.assign(document.createElement('p'), { textContent: error }));
    if (orderState.needsSetup || /Company ID|API token/.test(error)) {
      const open = Object.assign(document.createElement('button'), { className: 'primary-soft', textContent: 'Open Settings' });
      open.addEventListener('click', () => { setModal('#orders-sheet', false); openSettings(); });
      empty.append(open);
    }
  } else if (loading && orders.length === 0) empty.textContent = 'Loading orders…';
  else if (!loading && orders.length === 0) {
    // Distinguish "nothing fetched" from "nothing under the current filter" — the latter read like
    // the fetch came back empty.
    empty.textContent = orderState.orders.length > 0
      ? 'No orders in this view — try another filter.'
      : 'No invoiced orders right now.';
  }
  $('#orders-table').classList.toggle('loading', loading);
  $('#orders-refresh').disabled = loading;
  $('#orders-loadbar').hidden = !loading;
  renderOrderDetail();
}

// Detail drawer: the headline fields first, then everything else the API returned.
const DETAIL_GROUPS = [
  ['Order', ['order_id', 'id', 'external_id', 'status', 'error_reason', 'marketplace', 'order_date', 'updated_at']],
  ['Event', ['event_name', 'venue_name', 'occurs_at', 'city', 'state', 'country', 'in_hand']],
  ['Tickets', ['section', 'row', 'low_seat', 'high_seat', 'quantity', 'delivery', 'zone_seating', 'transfer_count', 'deliver_urls']],
  ['Price', ['unit_price', 'total', 'markup_type', 'markup_unit', 'markup_amount']],
];
const MONEY_FIELDS = new Set(['unit_price', 'total']);
// Shown even when empty: Sync often sends no seat numbers, and a missing row reads like a bug.
const ALWAYS_SHOWN = new Set(['low_seat', 'high_seat']);
const NOT_PROVIDED = 'Not provided by Sync';
const DATE_FIELDS = new Set(['order_date', 'updated_at', 'occurs_at']);

function detailValue(key, value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (MONEY_FIELDS.has(key)) return money(value);
  if (DATE_FIELDS.has(key)) return shortDateTime(value);
  if (key === 'status' || key === 'marketplace' || key === 'delivery' || key === 'error_reason') return titleCase(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function renderOrderDetail() {
  const panel = $('#order-detail');
  const order = orderState.selected;
  panel.hidden = !order;
  if (!order) return;
  const head = document.createElement('header');
  head.append(
    Object.assign(document.createElement('h3'), { textContent: order.event_name ?? `Order ${order.order_id}` }),
    Object.assign(document.createElement('button'), { className: 'icon', textContent: '×', title: 'Close details', id: 'order-detail-close' }),
  );
  panel.replaceChildren(head);
  const meta = document.createElement('div');
  meta.className = 'detail-meta';
  meta.append(statusPill(order.status), Object.assign(document.createElement('span'), { textContent: `${titleCase(order.marketplace)} · #${order.order_id}` }));
  const when = Object.assign(document.createElement('p'), { className: 'detail-when', textContent: [eventDate(order.occurs_at), untilEvent(order.occurs_at)].filter(Boolean).join(' — ') });
  const search = Object.assign(document.createElement('button'), {
    className: 'primary-soft detail-search', textContent: 'Search event on Ticketmaster', disabled: !order.event_name,
  });
  search.dataset.search = order.id;
  panel.append(meta, when, search);
  // Direct event URL if the Automatiq record carried one. Skips the TM search and lands straight
  // on the ticket page — much faster, especially for non-TM marketplaces.
  const directURL = order.event_url || order.primary_marketplace_url || order.ticket_url;
  if (directURL && /^https?:\/\//i.test(directURL)) {
    const openDirect = Object.assign(document.createElement('button'), {
      className: 'primary detail-search', textContent: `Open event on ${titleCase(order.marketplace || 'site')}`,
    });
    openDirect.dataset.openDirect = order.id;
    panel.append(openDirect);
  }
  const shown = new Set();
  const addGroup = (title, keys) => {
    const rows = keys
      .map((key) => [key, detailValue(key, order[key]) ?? (ALWAYS_SHOWN.has(key) ? NOT_PROVIDED : null)])
      .filter(([, v]) => v !== null);
    for (const key of keys) shown.add(key);
    if (!rows.length) return;
    panel.append(Object.assign(document.createElement('h4'), { textContent: title }));
    const list = document.createElement('dl');
    for (const [key, value] of rows) {
      const dt = Object.assign(document.createElement('dt'), { textContent: titleCase(key) });
      const dd = document.createElement('dd');
      dd.append(Object.assign(document.createElement('span'), { textContent: value, className: value === NOT_PROVIDED ? 'missing' : '' }));
      if (value !== NOT_PROVIDED) {
        const copy = Object.assign(document.createElement('button'), { className: 'pd-btn', textContent: '⧉', title: `Copy ${titleCase(key)}` });
        copy.dataset.copy = value;
        dd.append(copy);
      }
      list.append(dt, dd);
    }
    panel.append(list);
  };
  for (const [title, keys] of DETAIL_GROUPS) addGroup(title, keys);
  addGroup('More', Object.keys(order).filter((key) => !shown.has(key)).sort());
}

async function openOrders() {
  setModal('#orders-sheet', true);
  await loadOrders();
}

$('#orders-open').addEventListener('click', openOrders);
window.fleet.onOpenOrders(openOrders);
$('#orders-close').addEventListener('click', () => setModal('#orders-sheet', false));
$('#orders-refresh').addEventListener('click', loadOrders);
$('#orders-table tbody').addEventListener('click', (event) => {
  const row = event.target.closest('tr[data-id]');
  if (!row) return;
  orderState.selected = orderState.orders.find((o) => String(o.id) === row.dataset.id) ?? null;
  renderOrders();
});
function searchOrderEvent(order) {
  if (!order?.event_name) return;
  setModal('#orders-sheet', false);
  const event = {
    eventName: order.event_name, venueName: order.venue_name, city: order.city, occursAt: order.occurs_at,
    section: order.section, row: order.row, quantity: order.quantity, orderId: order.order_id, marketplace: order.marketplace,
  };
  if (profiles.length === 0) return runEventSearch(event, null);
  togglePicker(false);
  pendingSearch = event;
  $('#picker-search-event').textContent = `${event.eventName} — ${eventDate(event.occursAt)}`;
  setPanelOpen(true);
  togglePicker(true);
}

function runEventSearch(event, profile) {
  pendingSearch = null;
  $('#picker-search-context').hidden = true;
  command('searchEvent', undefined, { ...event, profileId: profile?.id ?? null });
  showNotice(`Searching Ticketmaster for “${event.eventName}” on ${eventDate(event.occursAt)}${profile ? ` as ${profile.profile}` : ''}. The order details are in this tab's note.`);
}
$('#picker-search-noprofile').addEventListener('click', (event) => {
  event.stopPropagation();
  const search = pendingSearch;
  pendingSearch = null;
  togglePicker(false);
  if (search) runEventSearch(search, null);
});
document.querySelector('#orders-sheet').addEventListener('click', async (event) => {
  // Filter chip clicked → switch the view.
  const filter = event.target.closest('[data-filter]')?.dataset.filter;
  if (filter) {
    event.stopPropagation();
    orderState.filter = filter;
    renderOrders();
    return;
  }
  // Status dot clicked → cycle new → working → handled → new.
  const toggleId = event.target.closest('[data-status-toggle]')?.dataset.statusToggle;
  if (toggleId) {
    event.stopPropagation();
    const current = orderState.orders.find((o) => String(o.id) === toggleId)?.localStatus ?? 'new';
    const next = current === 'new' ? 'working' : current === 'working' ? 'handled' : 'new';
    try {
      await window.fleet.setOrderStatus(toggleId, next);
      const o = orderState.orders.find((o) => String(o.id) === toggleId);
      if (o) o.localStatus = next; // only after it persisted
    } catch { showNotice('Could not update the order status.'); }
    renderOrders();
    return;
  }
  // Mark handled button → one-shot toggle to handled (or back to new if already handled).
  const handledId = event.target.closest('[data-mark-handled]')?.dataset.markHandled;
  if (handledId) {
    event.stopPropagation();
    const o = orderState.orders.find((o) => String(o.id) === handledId);
    const next = o?.localStatus === 'handled' ? 'new' : 'handled';
    try {
      await window.fleet.setOrderStatus(handledId, next);
      if (o) o.localStatus = next; // only after it persisted
    } catch { showNotice('Could not update the order status.'); }
    renderOrders();
    return;
  }
  // Original search button handling.
  const id = event.target.closest('[data-search]')?.dataset.search;
  if (!id) return;
  event.stopPropagation();
  searchOrderEvent(orderState.orders.find((o) => String(o.id) === id));
}, true);
// When the main process bumps a status (e.g. the Search button or auto-open watcher), the Orders
// panel updates even if it was already rendered.
window.fleet.onOrderStatusChanged?.(({ id, status }) => {
  const o = orderState.orders.find((o) => String(o.id) === String(id));
  if (!o) return;
  o.localStatus = status;
  renderOrders();
});

$('#order-detail').addEventListener('click', (event) => {
  if (event.target.id === 'order-detail-close') {
    orderState.selected = null;
    renderOrders();
    return;
  }
  if (event.target.dataset.copy !== undefined) {
    command('copy', undefined, event.target.dataset.copy);
    showNotice(`Copied ${event.target.title.replace(/^Copy /, '')}.`);
    return;
  }
  // "Open event on <site>" button: route through the existing search flow so profile picker and
  // seat-match payload attach, but with the direct URL instead of the TM search URL.
  const directId = event.target.dataset.openDirect;
  if (directId) {
    const order = orderState.orders.find((o) => String(o.id) === directId);
    if (order) searchOrderEvent(order);
  }
});

// ---------- Group dialog ----------

// The group is picked on the start screen and locked for the session. This dialog shows it, renames
// groups, and restarts TabSolo to change group. Only a session without a group can choose one here.
const groupDialog = { renaming: null };

function openGroupDialog() {
  groupDialog.renaming = null;
  renderGroupDialog();
  setModal('#group-sheet', true);
}

function renderGroupDialog() {
  const active = activeGroupInfo();
  $('#group-intro').textContent = active
    ? `This session works in ${active.name}: only its accounts can be used in tabs.`
    : 'Choose the group of accounts to work in. It stays the same until TabSolo restarts.';
  $('#group-list').replaceChildren(...(state.groups ?? []).map((g) => {
    const item = document.createElement('li');
    item.dataset.group = g.key;
    item.style.setProperty('--group-color', g.color);
    item.classList.toggle('current', g.key === state.activeGroup);
    if (groupDialog.renaming === g.key) {
      const input = Object.assign(document.createElement('input'), { type: 'text', value: g.name, maxLength: 40, className: 'group-rename-input' });
      const save = Object.assign(document.createElement('button'), { type: 'button', className: 'primary-soft', textContent: 'Save' });
      save.dataset.action = 'save-name';
      const cancel = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Cancel' });
      cancel.dataset.action = 'cancel-rename';
      item.append(Object.assign(document.createElement('span'), { className: 'group-dot' }), input, save, cancel);
      setTimeout(() => input.select(), 0);
      return item;
    }
    const text = document.createElement('div');
    text.className = 'group-row-text';
    text.append(
      Object.assign(document.createElement('strong'), { textContent: g.name }),
      Object.assign(document.createElement('span'), {
        textContent: `${g.count} account${g.count === 1 ? '' : 's'}${g.name !== (g.key || 'Ungrouped') ? ` · sheet: ${g.key || 'no group'}` : ''}`,
      }),
    );
    const rename = Object.assign(document.createElement('button'), { type: 'button', className: 'link', textContent: 'Rename' });
    rename.dataset.action = 'rename';
    item.append(Object.assign(document.createElement('span'), { className: 'group-dot' }), text, rename);
    if (g.key === state.activeGroup) {
      item.append(Object.assign(document.createElement('span'), { className: 'group-current-tag', textContent: '🔒 This session' }));
    } else if (!active) {
      const use = Object.assign(document.createElement('button'), { type: 'button', className: 'primary-soft', textContent: 'Use this group' });
      use.dataset.action = 'choose';
      item.append(use);
    }
    return item;
  }));
  $('#group-locked-note').hidden = !active || (state.groups?.length ?? 0) < 2;
  if (active) $('.locked-name').textContent = active.name;
}

async function chooseGroup(key) {
  const result = await window.fleet.switchGroup({ group: key });
  if (result.error) return showNotice(result.error);
  setModal('#group-sheet', false);
  showNotice(`Working in ${groupNameOf(key)} for this session.`);
}

$('#group-badge').addEventListener('click', openGroupDialog);
$('#group-close').addEventListener('click', () => setModal('#group-sheet', false));
$('#group-list').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  const key = event.target.closest('li[data-group]')?.dataset.group;
  if (!button || key === undefined) return;
  const action = button.dataset.action;
  if (action === 'choose') chooseGroup(key);
  else if (action === 'rename') { groupDialog.renaming = key; renderGroupDialog(); }
  else if (action === 'cancel-rename') { groupDialog.renaming = null; renderGroupDialog(); }
  else if (action === 'save-name') {
    const name = event.target.closest('li').querySelector('.group-rename-input').value;
    const result = await window.fleet.renameGroup({ group: key, name });
    if (result?.error) return showNotice(result.error);
    groupDialog.renaming = null;
    renderGroupDialog();
  }
});
$('#group-list').addEventListener('keydown', (event) => {
  if (!event.target.matches('.group-rename-input')) return;
  if (event.key === 'Enter') { event.preventDefault(); event.target.closest('li').querySelector('[data-action="save-name"]').click(); }
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); groupDialog.renaming = null; renderGroupDialog(); }
});
$('#group-restart').addEventListener('click', () => {
  if (confirm('Restart TabSolo to choose another group?\n\nAll tabs close. Accounts stay signed in and come back when you work in their group again.')) {
    window.fleet.restartForGroup();
  }
});

// Start screen: with several groups the user picks one before launching.
function renderLaunchGroups() {
  const groups = state.groups ?? [];
  const fieldset = $('#launch-group');
  fieldset.hidden = groups.length < 2;
  if (fieldset.hidden) return;
  const list = $('#launch-group-list');
  const chosen = list.querySelector('input:checked')?.value;
  const key = JSON.stringify(groups.map((g) => [g.key, g.name, g.count, g.color]).concat([state.activeGroup]));
  if (list.dataset.key === key) return;
  list.dataset.key = key;
  list.replaceChildren(...groups.map((g) => {
    const label = document.createElement('label');
    label.className = 'launch-group';
    label.style.setProperty('--group-color', g.color);
    const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'group', value: g.key, checked: g.key === chosen });
    const text = document.createElement('span');
    text.append(
      Object.assign(document.createElement('span'), { className: 'group-dot' }),
      Object.assign(document.createElement('strong'), { textContent: g.name }),
      Object.assign(document.createElement('small'), { textContent: `${g.count} account${g.count === 1 ? '' : 's'}${g.key === state.activeGroup ? ' · last used' : ''}` }),
    );
    label.append(input, text);
    return label;
  }));
}

async function runAutoLogin() {
  showNotice('🔑 Auto login running — opening the login page, filling in details, submitting…');
  const result = await window.fleet.invoke('autoLogin', state.selectedId, 0);
  if (!result) return;
  if (result.error) showNotice(result.error);
  else if (result.otpFilled) showNotice(`Auto login signed in and filled an OTP (${result.otpFilled} field). Watch the page.`);
  else showNotice(`Auto login filled ${result.filled} field(s) and clicked "${result.submitted}". Watch the page.`);
}

$('#profile-details').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const profile = profiles.find((p) => p.id === selectedTab()?.profileId);
  if (!profile) return;
  const { action } = button.dataset;
  if (action === 'copy') {
    command('copy', undefined, button.dataset.value);
    showNotice(`Copied ${button.dataset.label}.`);
  } else if (action === 'copy-secret') {
    const result = await window.fleet.invoke('copySecret', state.selectedId, button.dataset.field);
    showNotice(result?.error ?? `Copied ${button.dataset.label}.`);
  } else if (action === 'fetch-otp') {
    button.disabled = true;
    try {
      // Watches for the code and fills it into the page; the background progress/result is surfaced
      // via the notice bar from main. The one-shot (OTP-URL) path returns the code directly.
      const result = await window.fleet.invoke('watchOTP', state.selectedId);
      if (result?.code) {
        otpCodes.set(profile.id, result.code);
        renderPanel();
        showNotice(result.error || `OTP ${result.code} filled in.`);
      } else if (result?.error) showNotice(result.error);
    } finally {
      button.disabled = false;
    }
  } else if (action === 'unselect') command('setProfile', state.selectedId, null);
  else if (action === 'autofill') runAutofill();
  else if (action === 'autofill-submit') runFillNext();
  else if (action === 'auto-login' && profile.url) runAutoLogin();
  else if (action === 'menu') openProfileMenu(profile, button);
});
$('#profile-empty').addEventListener('click', (event) => {
  const action = event.target.dataset.action;
  if (action === 'import') $('#profile-import').click();
  else if (action === 'new') openEditor(null);
});

// Profile picker: opens the search/list under the trigger. Closes when a profile is picked, when
// Esc is pressed, or on outside click.
const pickerBtn = $('#profile-picker-btn');
const pickerMenu = $('#profile-picker-menu');
function togglePicker(force) {
  const open = force === undefined ? pickerMenu.hidden : force;
  pickerMenu.hidden = !open;
  if (!open && pendingSearch) {
    pendingSearch = null; // closed without picking: the search is cancelled
    showNotice('Search cancelled.');
  }
  $('#picker-search-context').hidden = !pendingSearch;
  pickerBtn.setAttribute('aria-expanded', String(open));
  $('#profile-search').setAttribute('aria-expanded', String(open));
  if (!open) $('#profile-search').removeAttribute('aria-activedescendant');
  if (open) {
    renderPickerList();
    $('#profile-search').focus();
    $('#profile-search').select();
  }
}
pickerBtn.addEventListener('click', () => {
  // Opening the picker by hand is a profile assignment, not a continuation of an abandoned order
  // search — drop any stale pendingSearch so clicking a profile assigns it instead of re-searching.
  if (pickerMenu.hidden) pendingSearch = null;
  togglePicker();
});
document.addEventListener('click', (event) => {
  if (pickerMenu.hidden || event.target.closest('.profile-picker')) return;
  // An incidental outside click (e.g. clicking the address bar) just hides the menu. It must NOT
  // throw away a pending order-search — reopening the picker continues it. Esc / the no-profile
  // button stay the explicit cancel.
  if (pendingSearch) {
    pickerMenu.hidden = true;
    pickerBtn.setAttribute('aria-expanded', 'false');
  } else {
    togglePicker(false);
  }
});

/** Keyboard: arrow up/down moves selection in the picker list; Enter picks it; Esc closes. */
function pickerKeyNav(delta) {
  const items = [...$('#profile-results').querySelectorAll('li[data-id]')];
  if (items.length === 0) return;
  const current = items.findIndex((li) => li.classList.contains('kb-focus'));
  const next = Math.max(0, Math.min(items.length - 1, (current === -1 ? 0 : current + delta)));
  items.forEach((li, i) => li.classList.toggle('kb-focus', i === next));
  items[next].scrollIntoView({ block: 'nearest' });
  $('#profile-search').setAttribute('aria-activedescendant', items[next].id || ''); // tell AT which option is highlighted
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !pickerMenu.hidden) { event.preventDefault(); togglePicker(false); pickerBtn.focus(); return; }
  if (pickerMenu.hidden) return;
  if (event.key === 'ArrowDown') { event.preventDefault(); pickerKeyNav(1); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); pickerKeyNav(-1); }
  else if (event.key === 'Enter') {
    const focused = $('#profile-results').querySelector('li.kb-focus');
    if (focused) { event.preventDefault(); focused.click(); }
  }
});
// "⋯" manage menu next to the picker: profile import/export, bulk assign, theme, help.
const manageMenu = $('#manage-menu');
const manageBtn = $('#manage-menu-btn');
manageMenu.querySelectorAll('button').forEach((b) => b.setAttribute('role', 'menuitem')); // role=menu needs menuitem children
function toggleManageMenu(force) {
  const open = force === undefined ? manageMenu.hidden : force;
  manageMenu.hidden = !open;
  manageBtn.setAttribute('aria-expanded', String(open));
  if (open) {
    const rect = manageBtn.getBoundingClientRect();
    manageMenu.style.top = `${rect.bottom + 4}px`;
    manageMenu.style.left = `${Math.max(8, rect.right - 220)}px`;
  }
}
manageBtn.addEventListener('click', () => toggleManageMenu());
manageMenu.addEventListener('click', (event) => {
  if (event.target.closest('button')) toggleManageMenu(false);
});
document.addEventListener('click', (event) => {
  if (!manageMenu.hidden && !event.target.closest('#manage-menu') && !event.target.closest('#manage-menu-btn')) toggleManageMenu(false);
});

// Bulk assign: a checklist of every profile, handed out to tabs in order.
function renderBulkList() {
  $('#bulk-list').replaceChildren(...activeProfiles().map((p) => {
    const item = document.createElement('li');
    const label = document.createElement('label');
    label.className = 'check';
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: checkedProfiles.has(p.id) });
    box.dataset.id = p.id;
    label.append(box, Object.assign(document.createElement('span'), { textContent: p.email ? `${p.profile} · ${p.email}` : p.profile }));
    item.append(label);
    return item;
  }));
}

function openBulkAssign() {
  checkedProfiles.clear();
  const active = activeGroupInfo();
  $('#bulk-group-name').textContent = active ? `Accounts in ${active.name}` : 'Choose a group first.';
  renderBulkList();
  $('#profile-bulk').hidden = false;
  setProfileMode('bulk');
}
$('#bulk-select-all').addEventListener('click', () => {
  for (const box of $('#bulk-list').querySelectorAll('input[type="checkbox"]')) {
    box.checked = true;
    checkedProfiles.add(box.dataset.id);
  }
});
function closeBulkAssign() {
  $('#profile-bulk').hidden = true;
  setProfileMode('list');
}
$('#profile-bulk-open').addEventListener('click', openBulkAssign);
$('#profile-bulk-cancel').addEventListener('click', closeBulkAssign);
$('#bulk-list').addEventListener('change', (event) => {
  const id = event.target.dataset.id;
  if (!id) return;
  if (event.target.checked) checkedProfiles.add(id);
  else checkedProfiles.delete(id);
});
$('#profile-import').addEventListener('click', async () => {
  showNotice(describeImport(await window.fleet.importProfilesFile()));
});
$('#profile-export').addEventListener('click', async () => {
  const result = await window.fleet.exportProfilesFile();
  if (result?.canceled) return;
  if (result?.error) return showNotice(result.error);
  showNotice(`Exported ${result.exported} profile(s) to:\n${result.path}\nSecrets (card numbers, CVVs, passwords, keys) are stripped — fill them back in before re-importing.`);
});
window.fleet.onProfilesImported((result) => showNotice(describeImport(result)));
window.fleet.onProfilesChanged(refreshProfiles);
$('#profile-assign-all').addEventListener('click', async () => {
  const ordered = profiles.filter((p) => checkedProfiles.has(p.id)).map((p) => p.id);
  if (ordered.length === 0) return showNotice('Tick at least one profile first.');
  await window.fleet.invoke('assignProfiles', undefined, { profileIds: ordered, repeat: $('#profile-repeat').checked });
  showNotice(`Assigned ${ordered.length} profile(s) across tabs.`);
  closeBulkAssign();
});
$('#profile-delete-all').addEventListener('click', async () => {
  if (!confirm(`Delete all ${profiles.length} saved profiles? This can't be undone.`)) return;
  await window.fleet.deleteProfiles(null);
});
// ---------- Profile editor ----------

const editor = $('#profile-editor');
// What's being edited: saved cards are referenced by index (the window never has their numbers).
let editing = null; // { id, savedCards, keepCards: Set<number>, newCards: [] }
let editorDirty = false; // set by user typing; guards against discarding unsaved edits
editor.addEventListener('input', () => { editorDirty = true; });

// Which section of the profile UI is in view: the list, the editor, or the Google Sheet form.
// Hides the siblings via CSS so the panel stays focused on one thing at a time.
function setProfileMode(mode) {
  $('#profile-section').dataset.mode = mode;
}

function openEditor(profile = null) {
  editor.reset();
  sheetForm.hidden = true;
  editing = { id: profile?.id ?? null, savedCards: profile?.cards ?? [], keepCards: new Set((profile?.cards ?? []).map((_, i) => i)), newCards: [] };
  $('#editor-title').textContent = profile ? `Edit ${profile.profile}` : 'New profile';
  for (const key of ['profile', 'group', 'site', 'name', 'email', 'phone', 'smsNumber', 'address1', 'address2', 'city', 'state', 'zip', 'country', 'passwordUrl', 'otpUrl', 'url', 'dob', 'buyer', 'notes']) {
    editor.elements[key].value = profile?.[key] ?? '';
  }
  // A new profile goes into the group being worked in, so it can be used straight away.
  if (!profile && state.activeGroup) editor.elements.group.value = state.activeGroup;
  editor.elements.favorite.checked = Boolean(profile?.favorite);
  editor.elements.resolversText.value = (profile?.resolvers ?? []).map((col) => {
    const entries = col.entries.map((e) => `${e.field}=${e.resolver}`).join(', ');
    return `Site:${col.site} → ${entries}`;
  }).join('\n');
  editor.elements.password.placeholder = profile?.hasPassword ? 'Saved — type to replace' : '';
  editor.elements.passwordAuth.placeholder = profile?.hasPasswordAuth ? 'Saved — type to replace' : 'Bearer secret-token';
  editor.elements.otpAuth.placeholder = profile?.hasOtpAuth ? 'Saved — type to replace' : 'Bearer secret-token';
  editor.elements.textChestKey.placeholder = profile?.hasTextChestKey ? 'Saved — type to replace' : 'From api.textchest.com → API keys';
  editor.querySelector('[data-when-saved="password"]').hidden = !profile?.hasPassword;
  editor.querySelector('[data-when-saved="passwordUrl"]').hidden = !profile?.hasPasswordUrl;
  editor.querySelector('[data-when-saved="passwordAuth"]').hidden = !profile?.hasPasswordAuth;
  editor.querySelector('[data-when-saved="otpUrl"]').hidden = !profile?.hasOtpUrl;
  editor.querySelector('[data-when-saved="otpAuth"]').hidden = !profile?.hasOtpAuth;
  editor.querySelector('[data-when-saved="textChestKey"]').hidden = !profile?.hasTextChestKey;
  editor.querySelector('.editor-sync').open = Boolean(profile?.hasPasswordUrl || profile?.hasOtpUrl || profile?.hasTextChestKey);
  $('#editor-delete').hidden = !profile;
  showEditorErrors([]);
  renderEditorCards();
  editor.hidden = false;
  setProfileMode('editor');
  editor.elements.profile.focus();
  editorDirty = false; // programmatic fills above don't count as edits
}

function closeEditor(force = false) {
  // Don't silently throw away a long card/credential edit on a stray Esc or Cancel click.
  if (!force && editorDirty && !window.confirm('Discard unsaved changes to this profile?')) return;
  editorDirty = false;
  editor.reset();
  editing = null;
  editor.hidden = true;
  setProfileMode('list');
}

function showEditorErrors(errors) {
  $('#editor-errors').textContent = errors.join(' ');
  $('#editor-errors').hidden = errors.length === 0;
}

function renderEditorCards() {
  const describeCard = (card) => `${(card.last4 ?? card.number.slice(-4)) ? `•••• ${card.last4 ?? card.number.slice(-4)}` : 'Saved card (CVV only)'}${card.expMonth ? `  ${card.expMonth}/${String(card.expYear).slice(-2)}` : ''}`;
  $('#editor-cards').replaceChildren(
    ...editing.savedCards.map((card, index) => {
      const kept = editing.keepCards.has(index);
      const item = document.createElement('li');
      item.classList.toggle('removed', !kept);
      item.append(
        Object.assign(document.createElement('span'), { textContent: describeCard(card) }),
        Object.assign(document.createElement('button'), { type: 'button', textContent: kept ? 'Remove' : 'Undo', className: kept ? 'danger' : '' }),
      );
      item.lastChild.dataset.saved = index;
      return item;
    }),
    ...editing.newCards.map((card, index) => {
      const item = document.createElement('li');
      item.append(
        Object.assign(document.createElement('span'), { textContent: `${describeCard(card)}  (new)` }),
        Object.assign(document.createElement('button'), { type: 'button', textContent: 'Remove', className: 'danger' }),
      );
      item.lastChild.dataset.added = index;
      return item;
    }),
  );
}

/** Moves the card fields into the pending list; returns false if they're empty. */
function takeCardFields() {
  const f = editor.elements;
  if (!f.cardNumber.value.trim() && !f.cardCvv.value.trim()) return false;
  editing.newCards.push({
    number: f.cardNumber.value.replace(/\D/g, ''),
    name: f.cardName.value.trim(),
    expMonth: f.cardMonth.value.trim(),
    expYear: f.cardYear.value.trim(),
    cvv: f.cardCvv.value.trim(),
  });
  for (const key of ['cardNumber', 'cardName', 'cardMonth', 'cardYear', 'cardCvv']) f[key].value = '';
  return true;
}

$('#profile-new').addEventListener('click', () => openEditor(null));

// ---------- Google Sheets import ----------

const sheetForm = $('#sheet-import');
function openSheetForm() {
  editor.hidden = true;
  editing = null;
  sheetForm.hidden = false;
  setProfileMode('sheet');
  sheetForm.elements.url.focus();
}
function closeSheetForm() {
  sheetForm.hidden = true;
  sheetForm.reset();
  setProfileMode('list');
}
$('#profile-sheet').addEventListener('click', openSheetForm);
window.fleet.onOpenSheetImport(openSheetForm);
$('#sheet-import-cancel').addEventListener('click', closeSheetForm);

sheetForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = sheetForm.elements.url.value.trim();
  if (!url) return showNotice('Paste a Google Sheets link first.');
  const result = await window.fleet.openGoogleSheet(url);
  showNotice(result.error ?? 'Sheet opened. Sign in to Google if the sheet is private, then click Import this sheet.');
});
$('#sheet-import-run').addEventListener('click', async () => {
  const url = sheetForm.elements.url.value.trim();
  if (!url) return showNotice('Paste a Google Sheets link first.');
  const result = await window.fleet.importFromSheet(url);
  if (result.error) {
    showNotice(result.error);
    if (result.needsSignIn && result.sheetUrl) await window.fleet.openGoogleSheet(result.sheetUrl);
    return;
  }
  showNotice(describeImport(result));
  closeSheetForm();
});
$('#editor-cancel').addEventListener('click', () => closeEditor()); // not `closeEditor` — the event arg would look like force=true
$('#card-add').addEventListener('click', () => {
  if (takeCardFields()) renderEditorCards();
});
$('#editor-cards').addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.saved !== undefined) {
    const index = Number(button.dataset.saved);
    if (editing.keepCards.has(index)) editing.keepCards.delete(index);
    else editing.keepCards.add(index);
  } else if (button.dataset.added !== undefined) {
    editing.newCards.splice(Number(button.dataset.added), 1);
  }
  renderEditorCards();
});
editor.addEventListener('submit', async (event) => {
  event.preventDefault();
  takeCardFields(); // a card typed but not "added" is still saved
  const f = editor.elements;
  const input = {
    id: editing.id,
    ...Object.fromEntries(['profile', 'group', 'site', 'name', 'email', 'phone', 'smsNumber', 'address1', 'address2', 'city', 'state', 'zip', 'country', 'passwordUrl', 'otpUrl', 'url', 'dob', 'buyer', 'notes']
      .map((key) => [key, f[key].value])),
    favorite: f.favorite.checked,
    password: f.password.value,
    passwordAuth: f.passwordAuth.value,
    otpAuth: f.otpAuth.value,
    textChestKey: f.textChestKey.value,
    resolversText: f.resolversText.value,
    clearPassword: f.clearPassword.checked,
    clearPasswordUrl: f.clearPasswordUrl.checked,
    clearPasswordAuth: f.clearPasswordAuth.checked,
    clearOtpUrl: f.clearOtpUrl.checked,
    clearOtpAuth: f.clearOtpAuth.checked,
    clearTextChestKey: f.clearTextChestKey.checked,
    keepCards: [...editing.keepCards],
    newCards: editing.newCards,
  };
  const result = await window.fleet.saveProfile(input);
  if (result.errors.length > 0) {
    showEditorErrors(result.errors);
    renderEditorCards();
    return;
  }
  const created = !editing.id;
  closeEditor(true);
  showNotice(created ? 'Profile created. Pick it from the Profile menu to put it on this tab.' : 'Profile saved.');
});
$('#editor-delete').addEventListener('click', async () => {
  const profile = profiles.find((p) => p.id === editing?.id);
  if (!profile || !confirm(`Delete profile "${profile.profile}"? Its saved logins and site data are deleted too.`)) return;
  await window.fleet.deleteProfiles([profile.id]);
  closeEditor(true);
  showNotice(`Deleted ${profile.profile}.`);
});

const selectedCard = () => Number($('#autofill-card')?.value) || 0;
async function runAutofill() {
  const result = await window.fleet.invoke('autofill', state.selectedId, selectedCard());
  if (!result) return;
  const cvvNote = result.cvvCard ? ` CVV is for card •••• ${result.cvvCard}.` : '';
  showNotice(result.error ?? `Filled ${result.filled} field(s).${cvvNote} Review the form before submitting.`);
}
async function runFillNext() {
  const result = await window.fleet.invoke('autofillSubmit', state.selectedId, selectedCard());
  if (!result) return;
  if (result.error) showNotice(result.error);
  else if (result.expanded) showNotice(result.note ?? `Clicked "${result.expanded}".`);
  else showNotice(`Filled ${result.filled} field(s), clicked "${result.submitted}". Watch the page.`);
}
async function runCheckConnections() {
  const result = await window.fleet.invoke('diagnoseSync', state.selectedId);
  if (!result) return;
  if (result.error) return showNotice(result.error);
  // Multi-line result goes into the notice as monospace-ish readable text.
  const notice = $('#notice');
  notice.textContent = result.report;
  notice.hidden = false;
  notice.style.whiteSpace = 'pre-wrap';
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => { notice.hidden = true; notice.style.whiteSpace = ''; }, 20000);
}

// ---------- Rendering ----------

function render() {
  const inBrowser = state.mode === 'browser';
  launcher.hidden = inBrowser;
  browser.hidden = !inBrowser;
  if (!inBrowser) return renderLaunchGroups();
  // Dense tab strip once the session grows past 15 tabs — the body uses a class to shrink
  // padding / font-size / minimum tab width, so a 25-tab shift still fits one row on a 13" screen.
  document.body.classList.toggle('tabs-dense', state.tabs.length >= 15);
  renderTabs();
  renderToolbar();
  renderPanel();
  renderRecorderButton();
  renderStatusStrip();
  renderFavoriteProfiles();
  if (!$('#playbooks-sheet').hidden) renderRecordingPanel();
}

// Favorite profiles (profile.favorite === true in profiles.json) show up as compact chips in the
// toolbar — click opens a NEW tab with that profile already attached. Keeps the common accounts a
// mouse click away without going through the Profiles panel.
function renderFavoriteProfiles() {
  const strip = $('#fav-profiles');
  if (!strip) return;
  const allFavs = (profiles || []).filter((p) => p.favorite && (!state.activeGroup || groupOf(p) === state.activeGroup));
  const favs = allFavs.slice(0, 8);
  strip.replaceChildren(...favs.map((p) => {
    const chip = document.createElement('button');
    chip.className = 'fav-chip';
    chip.textContent = (p.profile || '?').slice(0, 1).toUpperCase();
    chip.title = `New tab with ${p.profile}`;
    chip.dataset.profileId = p.id;
    if (p.color) chip.style.background = p.color;
    return chip;
  }));
  if (allFavs.length > favs.length) {
    const more = document.createElement('button');
    more.className = 'fav-chip fav-more';
    more.textContent = `+${allFavs.length - favs.length}`;
    more.title = `${allFavs.length - favs.length} more favorites — open the Profile menu`;
    more.addEventListener('click', () => { setPanelOpen(true); togglePicker(true); });
    strip.append(more);
  }
  strip.hidden = favs.length === 0;
}
document.addEventListener('click', (event) => {
  const chip = event.target.closest('#fav-profiles .fav-chip');
  if (!chip || !chip.dataset.profileId) return; // skip the "+N more" chip (it opens the picker itself)
  command('newTab', undefined, { smart: false, profileId: chip.dataset.profileId });
});

// Bottom status strip — the ambient info users keep re-querying through tooltips and panels.
// Shows: isolation mode, current tab's proxy IP + kind, current tab's profile, open-tab count,
// session uptime. Hidden on the launcher. Clicking the proxy opens the Proxy menu via the toolbar.
const sessionStartedAt = Date.now();
function renderStatusStrip() {
  const strip = $('#status-strip');
  if (!strip) return;
  if (state.mode !== 'browser') { strip.hidden = true; return; }
  strip.hidden = false;
  const tab = selectedTab();
  const mode = state.perTabProxies ? 'Per-tab proxies' : 'Shared session';
  const proxy = tab?.proxy
    ? `${tab.proxy}${tab.proxyKind && tab.proxyKind !== 'pinned' ? ` (${tab.proxyKind})` : ''}`
    : 'Direct';
  // When any pool proxies are in cooldown, append "N cool" so the rep notices the pool is shrinking.
  const stats = state.poolStats;
  const cooldownNote = stats && stats.cool > 0 ? ` · ${stats.cool} of ${stats.total} cooling` : '';
  const profile = tab?.profileName || '—';
  strip.querySelector('.st-mode').innerHTML = `<strong>${mode}</strong>`;
  strip.querySelector('.st-proxy').innerHTML = `🌐 ${escapeHTML(proxy)}${escapeHTML(cooldownNote)}`;
  strip.querySelector('.st-profile').innerHTML = `👤 ${escapeHTML(profile)}`;
  const attn = state.tabs.filter((t) => t.attention).length;
  const attnText = attn > 0 ? ` · ⚡ ${attn} need you` : '';
  // When any extras are multi-selected, surface the bulk-target count so the user sees how many
  // tabs the next ⌘1/⌘2/⌘3 will act on (always includes the currently focused tab).
  const bulkCount = selectedTabIds().length;
  const selectedText = multi.size > 0 ? ` · ✓ ${bulkCount} selected` : '';
  strip.querySelector('.st-tabs').innerHTML = `🪟 ${state.tabs.length} tab${state.tabs.length === 1 ? '' : 's'}${escapeHTML(attnText)}${escapeHTML(selectedText)}`;
  const mins = Math.floor((Date.now() - sessionStartedAt) / 60000);
  const label = mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
  strip.querySelector('.st-timer').innerHTML = `⏱ ${label}`;
}
function escapeHTML(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
// Keep the uptime fresh even when no state updates fire.
setInterval(() => { if (state.mode === 'browser') renderStatusStrip(); }, 30_000);

// Countdowns tick locally between state updates.
setInterval(() => {
  for (const timer of tabsEl.querySelectorAll('.timer[data-ends-at]:not([data-ends-at=""])')) {
    timer.textContent = formatRemaining(Number(timer.dataset.endsAt));
  }
  const tab = selectedTab();
  if (tab?.timerEndsAt) $('#timer-left').textContent = formatRemaining(tab.timerEndsAt);
}, 1000);

// Multi-select rules: Cmd/Ctrl-click toggles one tab in the set; Shift-click selects a range from
// the last single-selected tab. Any other click clears the set so a plain click behaves normally.
function rangeOf(fromId, toId) {
  const a = state.tabs.findIndex((t) => t.id === fromId);
  const b = state.tabs.findIndex((t) => t.id === toId);
  if (a === -1 || b === -1) return [toId];
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return state.tabs.slice(lo, hi + 1).map((t) => t.id);
}

tabsEl.addEventListener('click', (event) => {
  // A drag ends with a click synthesized on the pointerup target; drop that click so we don't
  // select-navigate to a random tab the user actually dragged over.
  if (suppressNextClick) { suppressNextClick = false; event.stopImmediatePropagation(); event.preventDefault(); return; }
  // Group chip click → toggle collapse. Right-click (handled below separately) opens the group menu.
  const chip = event.target.closest('.group-chip');
  if (chip) { command('toggleGroupCollapse', undefined, chip.dataset.groupId); return; }
  const el = event.target.closest('.tab');
  if (!el) return;
  if (event.target.closest('.close')) {
    // Closing a tab that's part of the active selection closes the WHOLE selection — the same set the
    // status strip counts as "✓ N selected" and the same tabs that show the selected ring (focused +
    // multi). A close click on a tab outside the selection closes only that tab.
    const inSelection = multi.size > 0 && (multi.has(el.dataset.id) || el.dataset.id === state.selectedId);
    if (inSelection) {
      command('closeTabs', undefined, selectedTabIds());
      multi.clear();
    } else {
      command('closeTab', el.dataset.id);
    }
    return;
  }
  if (event.metaKey || event.ctrlKey) {
    // Toggle this tab in the multi-set; keep whichever tab is "selected" selected for the view.
    if (multi.has(el.dataset.id)) multi.delete(el.dataset.id);
    else multi.add(el.dataset.id);
    renderTabs();
    return;
  }
  if (event.shiftKey && state.selectedId) {
    for (const id of rangeOf(state.selectedId, el.dataset.id)) multi.add(id);
    renderTabs();
    return;
  }
  multi.clear();
  command('selectTab', el.dataset.id);
});
tabsEl.addEventListener('auxclick', (event) => {
  const el = event.target.closest('.tab');
  if (el && event.button === 1) command('closeTab', el.dataset.id);
});

// Pointer-based tab reorder. HTML5 drag was flaky inside #chrome (user-select: none) in Electron
// even with -webkit-user-drag:element. Pointer events are simpler and give full control: we track
// position deltas, only start a "drag" once the user has moved past a small threshold (so clicks
// still work), use setPointerCapture so pointermove keeps firing even if the pointer leaves the
// element, and suppress the follow-up click so dropping doesn't also select-and-navigate the tab.
let dragState = null;
let suppressNextClick = false;

tabsEl.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.target.closest('button')) return; // close / profile clicks keep working
  const el = event.target.closest('.tab');
  if (!el) return;
  suppressNextClick = false; // clear a stale suppression from a drag whose click never landed
  dragState = { id: el.dataset.id, el, startX: event.clientX, moved: false, pointerId: event.pointerId };
  try { el.setPointerCapture(event.pointerId); } catch {}
});

tabsEl.addEventListener('pointermove', (event) => {
  if (!dragState) return;
  const dx = Math.abs(event.clientX - dragState.startX);
  if (!dragState.moved) {
    if (dx < 5) return;
    dragState.moved = true;
    dragState.el.classList.add('dragging');
  }
  // Clear previous drop indicator and compute a new one by hit-testing the current pointer x.
  for (const t of tabsEl.querySelectorAll('.drop-before, .drop-after')) {
    t.classList.remove('drop-before', 'drop-after');
  }
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.tab');
  if (!target || target.dataset.id === dragState.id) return;
  const rect = target.getBoundingClientRect();
  const before = (event.clientX - rect.left) < rect.width / 2;
  target.classList.add(before ? 'drop-before' : 'drop-after');
});

tabsEl.addEventListener('pointerup', (event) => {
  const s = dragState;
  dragState = null;
  if (!s) return;
  s.el.classList.remove('dragging');
  for (const t of tabsEl.querySelectorAll('.drop-before, .drop-after')) {
    t.classList.remove('drop-before', 'drop-after');
  }
  try { s.el.releasePointerCapture(s.pointerId); } catch {}
  if (!s.moved) return;
  suppressNextClick = true;
  // Figure out where to drop. elementFromPoint on pointerup gives us whatever tab the user let go
  // over; past the strip's right edge, drop at the end.
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.tab');
  let toIndex;
  if (target && target.dataset.id !== s.id) {
    const rect = target.getBoundingClientRect();
    const before = (event.clientX - rect.left) < rect.width / 2;
    toIndex = state.tabs.findIndex((t) => t.id === target.dataset.id);
    if (!before) toIndex += 1;
    const fromIndex = state.tabs.findIndex((t) => t.id === s.id);
    if (fromIndex !== -1 && fromIndex < toIndex) toIndex -= 1;
  } else if (!target) {
    toIndex = state.tabs.length - 1;
  } else {
    return; // dropped on itself — no-op
  }
  command('moveTab', s.id, toIndex);
});

tabsEl.addEventListener('pointercancel', () => {
  if (!dragState) return;
  dragState.el.classList.remove('dragging');
  for (const t of tabsEl.querySelectorAll('.drop-before, .drop-after')) {
    t.classList.remove('drop-before', 'drop-after');
  }
  dragState = null;
});

// Cmd/Ctrl + A on the tab strip selects every tab into the multi-set.
// Cmd/Ctrl + 1 opens the login page on every selected tab (autoLogin fills credentials too).
// Cmd/Ctrl + 2 fills the current form and submits it on every selected tab (autofillSubmit).
// When nothing is multi-selected, both shortcuts fall back to the one visible tab so they still work.
// The target set for bulk shortcuts: the currently visible tab PLUS everything in the multi-set.
// Previously this returned only `multi` when it was non-empty, which meant Cmd-clicking a few
// extra tabs made the currently focused tab silently drop out of the bulk operation — unexpected.
// Now the focused tab always participates.
function selectedTabIds() {
  const ids = new Set();
  if (state.selectedId) ids.add(state.selectedId);
  for (const id of multi) ids.add(id);
  return [...ids];
}

// Shared bulk-action runner for Ctrl/Cmd + 1 and Ctrl/Cmd + 2 — triggered BOTH from the in-page
// keydown listener (fires when the TabSolo UI has focus) AND from the menu accelerator IPC (fires
// when a tab's page has focus, since Chromium menu accelerators win over page keyboard handlers).
function runBulkShortcut(name) {
  const ids = selectedTabIds();
  if (ids.length === 0) {
    showNotice('No tab selected — click a tab first.');
    return;
  }
  const label = name === 'autoLogin' ? 'Auto-login'
    : name === 'autofillSubmit' ? 'Autofill + submit'
    : 'Go home';
  showNotice(ids.length > 1 ? `${label} running on ${ids.length} tabs.` : `${label} running…`);
  // `home` is a side-effect-only navigation; command() (fire-and-forget) is enough.
  // The autofill flavors can return errors we want to surface, so they use invoke().
  if (name === 'home') {
    for (const id of ids) command('home', id);
    return;
  }
  Promise.all(ids.map((id) => window.fleet.invoke(name, id, 0))).then((results) => {
    const errors = results.map((r, i) => r?.error && { id: ids[i], msg: r.error }).filter(Boolean);
    if (errors.length === 0) return;
    if (errors.length === ids.length) {
      showNotice(`${label} failed: ${errors[0].msg}`, 8000);
    } else {
      showNotice(`${label}: ${errors.length} of ${ids.length} tab(s) failed — ${errors[0].msg}`, 8000);
    }
  });
}
window.fleet.onBulkShortcut(runBulkShortcut);

// Main process asks us to prompt for a watch pattern (text or /regex/). Simple prompt() is enough
// here — the input is non-sensitive and this stays out of the way.
window.fleet.onPromptWatch?.(({ tabId, current }) => {
  const value = window.prompt('Watch this tab for a URL pattern (substring or /regex/):', current || '');
  if (value === null) return; // cancelled
  command('setWatchPattern', tabId, value);
  if (value.trim()) showNotice(`Watching tab for "${value.trim()}"`);
  else showNotice('Watch cleared.');
});

// Click an attention-flagged tab to acknowledge and clear the flag.
tabsEl.addEventListener('click', (event) => {
  if (suppressNextClick) return; // a just-finished drag isn't an acknowledgement (bubble guard consumes the flag)
  const el = event.target.closest('.tab.attention');
  if (!el) return;
  command('clearAttention', el.dataset.id);
}, true);

// Recent-messages popover anchored to the status strip. Opens on 🕘 click, closes on backdrop /
// Esc. Shows the last 50 notices with relative timestamps so the rep can catch what they missed.
const historyPopover = $('#history-popover');
const historyBtn = $('#st-history-btn');
async function openHistory() {
  const list = await window.fleet.recentNotices();
  const ul = $('#history-list');
  if (!Array.isArray(list) || list.length === 0) {
    ul.replaceChildren(Object.assign(document.createElement('li'), { className: 'empty', textContent: 'No recent messages.' }));
  } else {
    const rel = (ms) => {
      const d = Math.max(0, Math.round((Date.now() - ms) / 1000));
      if (d < 60) return `${d}s ago`;
      if (d < 3600) return `${Math.round(d / 60)}m ago`;
      return `${Math.round(d / 3600)}h ago`;
    };
    ul.replaceChildren(...list.map(({ text, at }) => {
      const li = document.createElement('li');
      const time = document.createElement('time');
      time.textContent = rel(at);
      li.append(time, document.createTextNode(text));
      return li;
    }));
  }
  historyPopover.hidden = false;
}
historyBtn?.addEventListener('click', openHistory);

// Account health map, keyed by profile id. Populated when Profiles → Check All Account Logins
// runs; the main process broadcasts the new results, we store and re-render the picker.
const accountHealthByProfile = new Map();
async function loadInitialHealth() {
  try {
    const cache = await window.fleet.accountHealth?.();
    if (cache?.results) for (const r of cache.results) accountHealthByProfile.set(r.profileId, r);
  } catch {}
}
loadInitialHealth();
window.fleet.onAccountHealthChanged?.(({ results }) => {
  accountHealthByProfile.clear();
  for (const r of results) accountHealthByProfile.set(r.profileId, r);
  if (!pickerMenu.hidden) renderPickerList();
});
$('#history-close')?.addEventListener('click', () => { historyPopover.hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !historyPopover.hidden) historyPopover.hidden = true; });
document.addEventListener('click', (e) => {
  if (historyPopover.hidden) return;
  if (historyPopover.contains(e.target) || historyBtn.contains(e.target)) return;
  historyPopover.hidden = true;
});

// ⌘P / Ctrl+P — fuzzy jump between open tabs. Searches title + host + profile; Enter switches,
// Esc closes, Up/Down move the highlight. The one place to land when you're deep in 20 tabs.
const paletteEl = $('#palette');
const paletteInput = $('#palette-input');
const paletteList = $('#palette-list');
let paletteFiltered = [];
let paletteIndex = 0;
function openPalette() {
  if (state.mode !== 'browser' || state.tabs.length === 0) return;
  paletteInput.value = '';
  paletteFiltered = state.tabs.slice();
  paletteIndex = Math.max(0, state.tabs.findIndex((t) => t.id === state.selectedId));
  renderPalette();
  setModal('#palette', true);
  paletteInput.focus();
}
function renderPalette() {
  const query = paletteInput.value.trim().toLowerCase();
  paletteFiltered = state.tabs.filter((t) => {
    if (!query) return true;
    const hay = `${t.title ?? ''} ${t.url ?? ''} ${t.profileName ?? ''} ${t.slot}`.toLowerCase();
    return hay.includes(query);
  });
  if (paletteIndex >= paletteFiltered.length) paletteIndex = Math.max(0, paletteFiltered.length - 1);
  paletteList.replaceChildren(...paletteFiltered.map((t, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(i === paletteIndex));
    li.dataset.id = t.id;
    let host = '';
    try { host = new URL(t.url).host; } catch {}
    li.innerHTML = `<span class="slot">${t.slot}</span>` +
      (t.favicon ? `<img src="${escapeHTML(t.favicon)}" alt="">` : '') +
      `<span>${escapeHTML(t.title)}</span>` +
      `<span class="meta">${escapeHTML([t.profileName, host].filter(Boolean).join(' · '))}</span>`;
    return li;
  }));
}
paletteInput?.addEventListener('input', () => { paletteIndex = 0; renderPalette(); });
paletteInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { setModal('#palette', false); return; }
  if (event.key === 'ArrowDown') { event.preventDefault(); paletteIndex = Math.min(paletteFiltered.length - 1, paletteIndex + 1); renderPalette(); return; }
  if (event.key === 'ArrowUp')   { event.preventDefault(); paletteIndex = Math.max(0, paletteIndex - 1); renderPalette(); return; }
  if (event.key === 'Enter' && paletteFiltered[paletteIndex]) {
    setModal('#palette', false);
    command('selectTab', paletteFiltered[paletteIndex].id);
  }
});
paletteList?.addEventListener('click', (event) => {
  const li = event.target.closest('li');
  if (!li) return;
  setModal('#palette', false);
  command('selectTab', li.dataset.id);
});
window.fleet.onOpenPalette?.(openPalette);

window.addEventListener('keydown', (event) => {
  if (!(event.metaKey || event.ctrlKey)) return;
  if (event.target.matches('input, textarea, [contenteditable]')) return;
  if (state.mode !== 'browser') return;
  const key = event.key.toLowerCase();
  if (key === 'a') {
    event.preventDefault();
    multi.clear();
    for (const t of state.tabs) multi.add(t.id);
    renderTabs();
    return;
  }
  if (key === '1' || key === '2' || key === '3') {
    event.preventDefault();
    runBulkShortcut(key === '1' ? 'autoLogin' : key === '2' ? 'autofillSubmit' : 'home');
    return;
  }
});
tabsEl.addEventListener('contextmenu', (event) => {
  const chip = event.target.closest('.group-chip');
  if (chip) {
    event.preventDefault();
    openGroupMenu(chip.dataset.groupId, event);
    return;
  }
  const el = event.target.closest('.tab');
  if (!el) return;
  event.preventDefault();
  // Pass the FULL selection (focused tab + multi extras) so bulk entries also appear when the
  // right-clicked tab is the focused one. Previously bulk entries hid whenever `multi` didn't
  // already include the right-clicked tab, which hurt the common "shift-click a range, right-
  // click the focused tab" workflow.
  command('tabMenu', el.dataset.id, selectedTabIds());
});

// Group chip menu — a popover with Rename, a row of colour swatches, Collapse/Expand, Ungroup and
// Close. Replaces the old free-text prompt() (type "rename <name>" / "color red"…), which was
// undiscoverable and typo-prone.
const GROUP_COLORS = {
  red: '#e03131', orange: '#f76707', amber: '#f59f00', yellow: '#fcc419',
  green: '#2f9e44', teal: '#0ca678', cyan: '#1098ad', sky: '#339af0',
  blue: '#1c7ed6', indigo: '#4263eb', violet: '#7048e8', purple: '#ae3ec9',
  pink: '#d6336c', brown: '#8d5524',
};
let groupMenuEl = null;
function closeGroupMenu() { groupMenuEl?.remove(); groupMenuEl = null; }
document.addEventListener('click', (event) => {
  if (groupMenuEl && !event.target.closest('#__group-menu')) closeGroupMenu();
});
function openGroupMenu(groupId, event) {
  const grp = (state.tabGroups || []).find((g) => g.id === groupId);
  if (!grp) return;
  closeGroupMenu();
  const menu = document.createElement('div');
  menu.id = '__group-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', `Group ${grp.name}`);
  menu.style.cssText = 'position:fixed;z-index:1000;min-width:180px;background:var(--panel-bg,#1b1f27);color:var(--text,#e8ecf1);border:1px solid var(--border,#333a46);border-radius:8px;padding:6px;box-shadow:0 12px 34px rgba(0,0,0,.45);font:13px -apple-system,system-ui,sans-serif';

  const item = (label, onClick, danger = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.textContent = label;
    b.style.cssText = `all:unset;display:block;box-sizing:border-box;width:100%;padding:6px 10px;border-radius:5px;cursor:pointer${danger ? ';color:#ff6b6b' : ''}`;
    b.addEventListener('mouseenter', () => { b.style.background = 'rgba(255,255,255,.08)'; });
    b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
    b.addEventListener('click', () => { closeGroupMenu(); onClick(); });
    menu.append(b);
  };

  item('✏ Rename…', () => {
    const name = prompt('Rename group', grp.name);
    if (name && name.trim()) command('renameGroup', undefined, { id: grp.id, name: name.trim() });
  });

  const colors = document.createElement('div');
  colors.setAttribute('role', 'group');
  colors.setAttribute('aria-label', 'Group colour');
  colors.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;padding:6px 10px';
  for (const [name, hex] of Object.entries(GROUP_COLORS)) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.setAttribute('role', 'menuitemradio');
    sw.setAttribute('aria-checked', String(grp.color === hex));
    sw.setAttribute('aria-label', `Colour ${name}`);
    sw.title = `Set colour ${name}`;
    sw.style.cssText = `all:unset;width:16px;height:16px;border-radius:50%;cursor:pointer;background:${hex};box-shadow:${grp.color === hex ? '0 0 0 2px #fff' : 'none'}`;
    sw.addEventListener('click', () => { closeGroupMenu(); command('setGroupColor', undefined, { id: grp.id, color: hex }); });
    colors.append(sw);
  }
  menu.append(colors);

  item(grp.collapsed ? '▸ Expand' : '▾ Collapse', () => command('toggleGroupCollapse', undefined, grp.id));
  item('⤫ Ungroup', () => { for (const t of state.tabs) if (t.groupId === grp.id) command('ungroupTab', t.id); });
  item('✕ Close all tabs', () => command('closeGroup', undefined, grp.id), true);

  document.body.append(menu);
  groupMenuEl = menu;
  // Keep the menu inside the window.
  const x = Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8);
  const y = Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8);
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;
}

$('#new-tab').addEventListener('click', (event) => {
  // Plain click → smart profile assignment picks the next free profile.
  // Shift+click → always open the picker (useful when you want a fresh unassigned tab).
  command('newTab', undefined, { smart: !event.shiftKey });
});
$('#new-tab').title = 'New tab (Shift+click: pick profile manually)';
$('#reload').addEventListener('click', () => command(selectedTab()?.loading ? 'stop' : 'reload'));
for (const button of document.querySelectorAll('[data-cmd]')) {
  button.addEventListener('click', () => command(button.dataset.cmd));
}
// 🧹 Clear button — bulk when multi-select active, single-tab hardReset otherwise.
$('#clear-tab-btn')?.addEventListener('click', () => {
  const ids = selectedTabIds();
  if (multi.size > 0 && ids.length > 1) {
    // Fire the IPC-level bulk command so the backend handles dedupe + reload.
    command('clearCookiesOn', undefined, ids);
  } else {
    command('hardReset');
  }
});
$('#region').addEventListener('change', (event) => command('setRegion', state.selectedId, event.target.value));

// Address bar: autocomplete over recent URLs (persisted to localStorage) + a built-in list of
// common ticketing destinations. Pressing Enter navigates to the typed text when no suggestion is
// highlighted, or the highlighted suggestion otherwise. ↑ / ↓ move the highlight.
const KNOWN_DESTINATIONS = [
  { url: 'https://www.ticketmaster.com/member', label: 'Ticketmaster — My Member' },
  { url: 'https://www.ticketmaster.com/myaccount', label: 'Ticketmaster — My Account' },
  { url: 'https://www.ticketmaster.com/orders', label: 'Ticketmaster — Orders' },
  { url: 'https://www.ticketmaster.ca/member', label: 'Ticketmaster CA — My Member' },
  { url: 'https://www.axs.com/mytickets', label: 'AXS — My Tickets' },
  { url: 'https://seatgeek.com/account', label: 'SeatGeek — Account' },
  { url: 'https://www.stubhub.com/account/orders', label: 'StubHub — Orders' },
  { url: 'https://app.seatscouts.com', label: 'Automatiq Sync' },
];
const RECENT_URL_KEY = 'fleet.recentUrls';
let recentUrls = [];
try { recentUrls = JSON.parse(localStorage.getItem(RECENT_URL_KEY) ?? '[]'); } catch {}
function rememberURL(url) {
  if (!/^https?:/i.test(url)) return;
  recentUrls = [url, ...recentUrls.filter((u) => u !== url)].slice(0, 50);
  try { localStorage.setItem(RECENT_URL_KEY, JSON.stringify(recentUrls)); } catch {}
}

const addressSuggest = $('#address-suggest');
let suggestIndex = -1;
let suggestItems = [];
function hideSuggest() { addressSuggest.hidden = true; suggestIndex = -1; }
function renderSuggest() {
  const q = address.value.trim().toLowerCase();
  if (!q) { hideSuggest(); return; }
  const pool = [...recentUrls.map((u) => ({ url: u, label: u })), ...KNOWN_DESTINATIONS];
  const seen = new Set();
  suggestItems = [];
  for (const item of pool) {
    if (suggestItems.length >= 8) break;
    if (seen.has(item.url)) continue;
    if (!item.url.toLowerCase().includes(q) && !item.label.toLowerCase().includes(q)) continue;
    seen.add(item.url);
    suggestItems.push(item);
  }
  if (suggestItems.length === 0) { hideSuggest(); return; }
  addressSuggest.replaceChildren(...suggestItems.map((item, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(i === suggestIndex));
    li.dataset.url = item.url;
    li.innerHTML = `<strong>${escapeHTML(item.label)}</strong><span>${escapeHTML(item.url)}</span>`;
    return li;
  }));
  addressSuggest.hidden = false;
}
address.addEventListener('input', () => { suggestIndex = -1; renderSuggest(); });
address.addEventListener('blur', () => setTimeout(hideSuggest, 150));
addressSuggest.addEventListener('mousedown', (event) => {
  // mousedown (not click) because blur fires first and hides the list before click would land.
  const li = event.target.closest('li');
  if (!li) return;
  event.preventDefault();
  address.value = li.dataset.url;
  rememberURL(li.dataset.url);
  hideSuggest();
  command('navigate', undefined, li.dataset.url);
  address.blur();
});

let addressSubmitBroadcast = false;
address.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.shiftKey) addressSubmitBroadcast = true;
});
$('#address-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const chosen = suggestIndex >= 0 && suggestItems[suggestIndex] ? suggestItems[suggestIndex].url : address.value;
  rememberURL(chosen);
  hideSuggest();
  if (addressSubmitBroadcast) {
    // Shift+Enter: send the URL to every selected tab (or just this tab if nothing's multi-selected).
    const ids = selectedTabIds();
    for (const id of ids) command('navigate', id, chosen);
    showNotice(ids.length > 1 ? `Navigated ${ids.length} tabs to ${chosen}` : `Navigated to ${chosen}`);
    addressSubmitBroadcast = false;
  } else {
    command('navigate', undefined, chosen);
  }
  address.blur();
});
address.addEventListener('focus', () => address.select());
address.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!addressSuggest.hidden) { hideSuggest(); event.preventDefault(); return; }
    address.value = selectedTab()?.url ?? '';
    address.blur();
    return;
  }
  if (addressSuggest.hidden || suggestItems.length === 0) return;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    suggestIndex = (suggestIndex + 1) % suggestItems.length;
    renderSuggest();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    suggestIndex = (suggestIndex - 1 + suggestItems.length) % suggestItems.length;
    renderSuggest();
  }
});

// Tab views sit below the chrome and left of the panel, so main needs both whenever they change.
function reportInsets() {
  window.fleet.setInsets({
    top: Math.ceil($('#chrome').getBoundingClientRect().height),
    left: panel.hidden ? 0 : PANEL_WIDTH,
    right: 0,
  });
  panel.style.top = `${Math.ceil($('#chrome').getBoundingClientRect().height)}px`;
}
new ResizeObserver(reportInsets).observe($('#chrome'));

window.fleet.onState((next) => {
  // Learn from where the user has actually been: any URL in the current state that isn't already
  // in the recent list is prepended. Keeps the autocomplete tied to real usage.
  for (const t of next.tabs ?? []) if (t.url) rememberURL(t.url);
  state = next;
  render();
  if (!$('#group-sheet').hidden && groupDialog.renaming === null) renderGroupDialog();
});
window.fleet.onFocusAddress(() => address.focus());

Promise.all([window.fleet.getInitial(), window.fleet.getSnippets(), window.fleet.listProfiles()]).then(([initial, savedSnippets, savedProfiles]) => {
  palette = initial.palette;
  snippets = savedSnippets;
  profiles = savedProfiles;
  $('#timer-presets').replaceChildren(...initial.timerPresets.map((minutes) => {
    const button = document.createElement('button');
    button.textContent = `${minutes}m`;
    button.dataset.minutes = minutes;
    return button;
  }));
  renderSwatches();
  renderSnippets();
  fillForm(initial.config);
  // The Settings-sheet theme (localStorage) is the user's standing choice; re-apply it so it wins
  // over the launcher config theme fillForm just set — otherwise a theme picked in Settings reverts.
  try { const t = localStorage.getItem('theme'); if (t) applyTheme(t); } catch {}
  let panelOpen = false;
  try {
    panelOpen = localStorage.getItem('panelOpen') === '1';
  } catch {}
  setPanelOpen(panelOpen);
  state = initial.state;
  render();
  $('#boot').hidden = true; // initial state is in; drop the startup placeholder
}).catch((error) => {
  // Don't leave the spinner turning forever if startup fails — say so.
  $('#boot')?.querySelector('.boot-spinner')?.remove();
  const p = $('#boot')?.querySelector('p');
  if (p) p.textContent = `Couldn't start TabSolo: ${error?.message || 'unknown error'}. Try restarting.`;
});
