'use strict';

// Playbooks: named, reusable sequences of recorded actions, saved under <userData>/playbooks/.
// A playbook is a JSON file:
//   {
//     id: 'uuid',
//     name: 'Ticketmaster primary - John Summit',
//     createdAt: 1793...,
//     hostPatterns: ['ticketmaster.com'],   // auto-matched when a tab is on one of these hosts
//     actions: [{ type, el, value?, varBinding?, url, t }, …]
//   }
// `varBinding` on an action tells the replayer to substitute the recorded value with a live order
// field at runtime: { field: 'section' | 'row' | 'seat' | 'email' | 'password' | 'eventUrl' }.

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function playbooksDir(baseDir) { return path.join(baseDir, 'playbooks'); }

function listPlaybooks(baseDir) {
  const dir = playbooksDir(baseDir);
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          return {
            id: data.id || f.replace(/\.json$/, ''),
            name: data.name || 'Untitled',
            createdAt: data.createdAt || 0,
            hostPatterns: data.hostPatterns || [],
            actionCount: Array.isArray(data.actions) ? data.actions.length : 0,
            fileName: f,
          };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch { return []; }
}

function savePlaybook(baseDir, { id, name, hostPatterns, actions }) {
  if (!Array.isArray(actions) || actions.length === 0) throw new Error('Playbook needs at least one action.');
  const dir = playbooksDir(baseDir);
  fs.mkdirSync(dir, { recursive: true });
  const playbook = {
    id: id || randomUUID(),
    name: String(name || 'Untitled').slice(0, 120),
    createdAt: Date.now(),
    hostPatterns: Array.isArray(hostPatterns) ? hostPatterns : [],
    actions,
  };
  const safeName = playbook.name.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60) || 'playbook';
  const fileName = `${safeName}-${playbook.id.slice(0, 8)}.json`;
  fs.writeFileSync(path.join(dir, fileName), JSON.stringify(playbook, null, 2));
  return { ...playbook, fileName };
}

function readPlaybook(baseDir, idOrFile) {
  const dir = playbooksDir(baseDir);
  // Allow either an id (preferred) or a filename.
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (data.id === idOrFile || f === idOrFile) return data;
    } catch {}
  }
  return null;
}

function deletePlaybook(baseDir, id) {
  const dir = playbooksDir(baseDir);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (data.id === id) { fs.unlinkSync(path.join(dir, f)); return true; }
    } catch {}
  }
  return false;
}

// -----------------------------------------------------------------------------------------------
// Auto-variable extraction. Given a list of raw recorded actions and a hint about what order
// field each one might represent, tag the matching inputs/clicks with a varBinding. This runs
// at save-time so later replays can substitute live order values.
//
// Heuristics (order fields are strings):
//   - input values that match the recording-time order's email/password/section/row/seat → tagged.
//   - clicks on elements with data-section-name === order.section → tagged as 'section'.
//   - clicks on elements with data-row-name / data-seat-name → tagged.
//   - URL changes that contain the order's event URL path → the whole nav is tagged 'eventUrl'.

const FIELD_PATTERNS = [
  { field: 'section',  match: (val, order) => order?.section && String(val) === String(order.section) },
  { field: 'row',      match: (val, order) => order?.row && String(val) === String(order.row) },
  { field: 'seat',     match: (val, order) => order?.lowSeat && String(val) === String(order.lowSeat) },
  { field: 'email',    match: (val, order) => order?.email && val === order.email },
  { field: 'password', match: (val, order) => order?.password && val === order.password },
];

function autoBindVariables(actions, context = {}) {
  const order = context.order || null;
  return actions.map((action) => {
    const copy = { ...action };
    // Click with data-* attribute matching an order field
    if (copy.type === 'click' && copy.el?.attrs) {
      const a = copy.el.attrs;
      if (order?.section && a['data-section-name'] === String(order.section)) copy.varBinding = { field: 'section' };
      if (order?.row && a['data-row-name'] === String(order.row)) copy.varBinding = { field: 'row' };
      if (order?.lowSeat && (a['data-seat-name'] === String(order.lowSeat) || a['data-seat'] === String(order.lowSeat))) {
        copy.varBinding = { field: 'seat' };
      }
    }
    // Input / change: if the value matches a known order field, tag it.
    if ((copy.type === 'input' || copy.type === 'change') && copy.value != null) {
      for (const { field, match } of FIELD_PATTERNS) {
        if (match(copy.value, order)) { copy.varBinding = { field }; break; }
      }
    }
    // URL navigation to the order's event URL
    if (copy.type === 'load' && order?.event_url && typeof copy.url === 'string' && copy.url.includes(order.event_url.replace(/^https?:\/\//, ''))) {
      copy.varBinding = { field: 'eventUrl' };
    }
    return copy;
  });
}

/** Resolves a varBinding against a live order record. Returns the raw recorded value as fallback. */
function substitute(action, liveOrder) {
  if (!action.varBinding || !liveOrder) return action;
  const field = action.varBinding.field;
  const live = {
    section: liveOrder.section,
    row: liveOrder.row,
    seat: liveOrder.lowSeat ?? liveOrder.low_seat,
    email: liveOrder.email,
    password: liveOrder.password,
    eventUrl: liveOrder.event_url ?? liveOrder.eventUrl,
  }[field];
  if (live == null) return action;
  if (action.type === 'input' || action.type === 'change') return { ...action, value: String(live) };
  if (action.type === 'load') return { ...action, url: String(live) };
  return action;
}

module.exports = { listPlaybooks, savePlaybook, readPlaybook, deletePlaybook, autoBindVariables, substitute };
