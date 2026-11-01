'use strict';

// Single source of truth for every rebindable action in TabSolo. The shortcuts sheet reads this
// list to render editable rows; main.js reads it to build menu accelerators; the renderer reads it
// to match in-window keystrokes. Keep IDs stable — stored overrides key off them.
//
// Each action has:
//   id        : stable identifier used in shortcuts.json and menu wiring
//   label     : human name shown in the sheet
//   group     : section title ("Navigation", "Multi-tab", "Audio", ...) to cluster the sheet
//   accelerator : default Chromium accelerator string ('CmdOrCtrl+1', 'Ctrl+Tab', …)
//   scope     : 'menu' (goes through a menu accelerator; works even in page focus),
//                'renderer' (only fires when TabSolo UI has focus),
//                'both' (menu + renderer handler, like multi-tab shortcuts)
//   description : one line explaining what it does
//   command   : the IPC command name sent to main when the renderer handles the key (optional for pure menu actions)

const ACTIONS = [
  // Navigation ---------------------------------------------------------------------------------
  { id: 'reload',       group: 'Navigation', label: 'Reload tab',           accelerator: 'CmdOrCtrl+R',             scope: 'menu' },
  { id: 'home',         group: 'Navigation', label: 'Go home',              accelerator: 'CmdOrCtrl+Shift+H',       scope: 'menu' },
  { id: 'focusAddress', group: 'Navigation', label: 'Focus address bar',    accelerator: 'CmdOrCtrl+L',             scope: 'menu' },
  { id: 'palette',      group: 'Navigation', label: 'Jump to tab (palette)', accelerator: 'CmdOrCtrl+P',            scope: 'menu' },
  { id: 'back',         group: 'Navigation', label: 'Back',                 accelerator: process.platform === 'darwin' ? 'Cmd+[' : 'Alt+Left', scope: 'menu' },
  { id: 'forward',      group: 'Navigation', label: 'Forward',              accelerator: process.platform === 'darwin' ? 'Cmd+]' : 'Alt+Right', scope: 'menu' },
  { id: 'nextTab',      group: 'Navigation', label: 'Next tab',             accelerator: 'Ctrl+Tab',                scope: 'menu' },
  { id: 'previousTab',  group: 'Navigation', label: 'Previous tab',         accelerator: 'Ctrl+Shift+Tab',          scope: 'menu' },

  // Multi-tab ----------------------------------------------------------------------------------
  { id: 'bulkAutoLogin',    group: 'Multi-tab', label: 'Auto-login on selected tabs',    accelerator: 'CmdOrCtrl+1', scope: 'both' },
  { id: 'bulkAutofillSubmit', group: 'Multi-tab', label: 'Autofill + submit on selected', accelerator: 'CmdOrCtrl+2', scope: 'both' },
  { id: 'bulkHome',         group: 'Multi-tab', label: 'Go home on selected tabs',       accelerator: 'CmdOrCtrl+3', scope: 'both' },
  { id: 'selectAll',        group: 'Multi-tab', label: 'Select every tab',               accelerator: 'CmdOrCtrl+A', scope: 'renderer' },
  { id: 'broadcastNav',     group: 'Multi-tab', label: 'Broadcast URL to selected',      accelerator: 'Shift+Enter in address bar', scope: 'renderer' },

  // Tabs ---------------------------------------------------------------------------------------
  { id: 'newTab',           group: 'Tabs', label: 'New tab',                      accelerator: 'CmdOrCtrl+T',       scope: 'menu' },
  { id: 'closeTab',         group: 'Tabs', label: 'Close current tab',            accelerator: 'CmdOrCtrl+W',       scope: 'menu' },
  { id: 'reopenClosed',     group: 'Tabs', label: 'Reopen last closed tab',       accelerator: 'CmdOrCtrl+Shift+T', scope: 'menu' },
  { id: 'duplicate',        group: 'Tabs', label: 'Duplicate tab',                accelerator: 'CmdOrCtrl+Shift+D', scope: 'menu' },

  // Proxy / sessions ---------------------------------------------------------------------------
  { id: 'burn',             group: 'Proxy', label: 'Burn IP + reload',             accelerator: 'CmdOrCtrl+B',      scope: 'menu' },
  { id: 'toggleProxy',      group: 'Proxy', label: 'Switch tab to local / proxy',  accelerator: 'CmdOrCtrl+Shift+P', scope: 'menu' },
  { id: 'muteAll',          group: 'Audio', label: 'Mute every tab (toggle)',      accelerator: 'CmdOrCtrl+Shift+M', scope: 'menu' },

  // Profiles / autofill ------------------------------------------------------------------------
  { id: 'autofill',         group: 'Profiles', label: 'Autofill current form',    accelerator: 'CmdOrCtrl+Shift+F', scope: 'menu' },
  { id: 'autofillSubmit',   group: 'Profiles', label: 'Autofill + submit',        accelerator: 'CmdOrCtrl+Shift+Enter', scope: 'menu' },
  { id: 'profilesPanel',    group: 'Profiles', label: 'Profiles panel + search',  accelerator: 'CmdOrCtrl+Shift+O', scope: 'menu' },
  { id: 'orders',           group: 'Profiles', label: 'Open Orders',              accelerator: 'CmdOrCtrl+Shift+U', scope: 'menu' },

  // Other --------------------------------------------------------------------------------------
  { id: 'toolsPanel',       group: 'Other', label: 'Toggle the side panel',       accelerator: 'CmdOrCtrl+\\',     scope: 'menu' },
  { id: 'noteTimestamp',    group: 'Other', label: 'Insert timestamp in note',    accelerator: 'CmdOrCtrl+Shift+T (inside the note)', scope: 'renderer' },
  { id: 'devtools',         group: 'Other', label: 'Open page DevTools',          accelerator: process.platform === 'darwin' ? 'Alt+Cmd+I' : 'Ctrl+Shift+I', scope: 'menu' },
  { id: 'help',             group: 'Other', label: 'Open this cheat sheet',       accelerator: '?',                scope: 'renderer' },
];

const DEFAULT_BY_ID = Object.fromEntries(ACTIONS.map((a) => [a.id, a.accelerator]));

/** Merges `overrides` {id → accelerator} with the defaults; invalid overrides are dropped. */
function resolveAccelerators(overrides = {}) {
  const out = { ...DEFAULT_BY_ID };
  for (const [id, accel] of Object.entries(overrides)) {
    if (!(id in DEFAULT_BY_ID)) continue;
    if (typeof accel !== 'string' || !accel.trim()) continue;
    out[id] = accel.trim();
  }
  return out;
}

module.exports = { ACTIONS, DEFAULT_BY_ID, resolveAccelerators };
