'use strict';

// Telemetry client. Batches events and errors to disk, flushes to the API every 60s. On network
// failure the queue stays on disk and retries next tick. Linked to the license key, which the
// website's admin panel can match to an account, so nothing the user typed or visited belongs here.
//
// Opt-out: `isEnabled` is asked every time, so unticking the setting takes effect immediately.

const fs = require('fs');
const path = require('path');
const os = require('os');

const FLUSH_INTERVAL_MS = 60_000;
const QUEUE_FILE = 'telemetry-queue.json';
const MAX_QUEUE = 500;

// User actions worth counting. Only the channel name is reported, never its arguments.
const FEATURES = new Set([
  'launch', 'recorder:start', 'playbooks:save-from-last-recording', 'playbooks:run', 'playbooks:run-on-url',
  'proxies:scan', 'proxies:scan-text', 'profiles:import-file', 'profiles:import-text', 'profiles:import-sheet',
  'profiles:save', 'profiles:export-file', 'groups:switch', 'sync:save-settings', 'orders:set-status',
  'accounts:health-check', 'seats:test', 'seats:test-flow', 'update:install-now',
]);

// Error text can quote what the user was doing: proxy logins, sites, emails, card numbers, their name in a path.
function scrub(text) {
  return String(text)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)]+/gi, (url) => (url.startsWith('file:') ? '[file]' : '[url]'))
    .replace(/[^\s@'"<>]+@[^\s@'"<>]+\.[^\s'"<>]+/g, '[email]')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?::[^\s:'"]+:[^\s'"]+)?/g, '[ip]')
    .replace(/\b(?:\d[ -]?){12,19}\b/g, '[number]')
    .replace(/(\/Users\/|\/home\/|[A-Z]:\\Users\\)[^/\\\s]+/gi, '$1[user]');
}

/** Reports feature use and failures from every ipcMain.handle in one place, without seeing arguments. */
function instrumentIpc(ipcMain, getClient) {
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => handle(channel, async (...args) => {
    const feature = FEATURES.has(channel);
    if (feature) getClient()?.trackEvent(channel);
    try {
      const result = await handler(...args);
      if (feature && result?.error) getClient()?.trackError(`${channel}: ${result.error}`, { kind: 'ipc', channel });
      return result;
    } catch (err) {
      getClient()?.trackError(err, { kind: 'ipc', channel });
      throw err;
    }
  });
}

function createTelemetryClient({ apiBase, dataDir, appVersion, deviceId, getLicenseKey, getToken, isEnabled = () => true }) {
  const base = (apiBase || '').replace(/\/+$/, '');
  const queuePath = path.join(dataDir, QUEUE_FILE);
  let queue = loadQueue();
  let timer = null;
  let flushing = false;
  // One report per distinct error per launch, so a failure in a loop can't push out everything else.
  const seenErrors = new Set();

  function loadQueue() {
    try { return JSON.parse(fs.readFileSync(queuePath, 'utf8')) || []; }
    catch { return []; }
  }
  function saveQueue() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = queuePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(queue));
      fs.renameSync(tmp, queuePath);
    } catch { /* ignore */ }
  }

  function enqueue(kind, body) {
    if (!isEnabled() || !base) return;
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push({ kind, body: { ...body, deviceId, appVersion, os: `${process.platform} ${os.release()}`, licenseKey: getLicenseKey?.() || null } });
    saveQueue();
  }

  function trackEvent(name, props) {
    enqueue('event', { name: String(name).slice(0, 64), props: props || null });
  }

  function trackError(err, context = {}) {
    const message = scrub(err?.message || err || 'unknown').slice(0, 2000);
    if (seenErrors.has(message)) return;
    seenErrors.add(message);
    const stack = err?.stack ? scrub(err.stack).slice(0, 8000) : null;
    enqueue('error', { kind: context.kind || 'generic', message, stack, context });
  }

  async function flush() {
    // Reports queued before someone opts out must not be sent afterwards.
    if (!isEnabled()) { if (queue.length) { queue = []; saveQueue(); } return; }
    if (!base || flushing || queue.length === 0) return;
    flushing = true;
    const token = getToken?.() || null;
    // No token yet (activation not complete): hold the queue, don't drop. The server rejects
    // unauthenticated writes, so sending would just burn battery and consume rate limits.
    if (!token) { flushing = false; return; }
    const batch = queue.slice(0, 20);
    const sent = [];
    for (const item of batch) {
      const url = `${base}/api/telemetry/${item.kind}`;
      try {
        const ctl = new AbortController();
        const timeout = setTimeout(() => ctl.abort(), 4000);
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...item.body, token }),
          signal: ctl.signal,
        });
        clearTimeout(timeout);
        if (res.ok) sent.push(item);
        else if (res.status >= 400 && res.status < 500 && res.status !== 401) sent.push(item); // malformed → drop; 401 → retry after re-validate
      } catch { /* keep in queue, try next tick */ }
    }
    if (sent.length) {
      queue = queue.filter((q) => !sent.includes(q));
      saveQueue();
    }
    flushing = false;
  }

  function start() {
    if (timer) return;
    timer = setInterval(flush, FLUSH_INTERVAL_MS);
    timer.unref?.();
    flush();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    flush();
  }

  return { trackEvent, trackError, flush, start, stop };
}

module.exports = { createTelemetryClient, instrumentIpc, scrub };
