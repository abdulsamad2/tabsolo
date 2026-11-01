'use strict';

// Telemetry client. Batches events and errors to disk, flushes to the API every 60s. On network
// failure the queue stays on disk and retries next tick. Pseudonymous — identified only by
// device_id and (optionally) license_key.
//
// Opt-out: pass `enabled: false` or set the `telemetryEnabled` config flag to false.

const fs = require('fs');
const path = require('path');
const os = require('os');

const FLUSH_INTERVAL_MS = 60_000;
const QUEUE_FILE = 'telemetry-queue.json';
const MAX_QUEUE = 500;

function createTelemetryClient({ apiBase, dataDir, appVersion, deviceId, getLicenseKey, enabled = true }) {
  const base = (apiBase || '').replace(/\/+$/, '');
  const queuePath = path.join(dataDir, QUEUE_FILE);
  let queue = loadQueue();
  let timer = null;
  let flushing = false;

  function loadQueue() {
    try { return JSON.parse(fs.readFileSync(queuePath, 'utf8')) || []; }
    catch { return []; }
  }
  function saveQueue() {
    try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(queuePath, JSON.stringify(queue)); } catch { /* ignore */ }
  }

  function enqueue(kind, body) {
    if (!enabled || !base) return;
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push({ kind, body: { ...body, deviceId, appVersion, os: `${process.platform} ${os.release()}`, licenseKey: getLicenseKey?.() || null } });
    saveQueue();
  }

  function trackEvent(name, props) {
    enqueue('event', { name: String(name).slice(0, 64), props: props || null });
  }

  function trackError(err, context = {}) {
    const message = String(err?.message || err || 'unknown').slice(0, 2000);
    const stack = err?.stack ? String(err.stack).slice(0, 8000) : null;
    enqueue('error', { kind: context.kind || 'generic', message, stack, context });
  }

  async function flush() {
    if (!enabled || !base || flushing || queue.length === 0) return;
    flushing = true;
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
          body: JSON.stringify(item.body),
          signal: ctl.signal,
        });
        clearTimeout(timeout);
        if (res.ok) sent.push(item);
        else if (res.status >= 400 && res.status < 500) sent.push(item); // malformed → drop
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

module.exports = { createTelemetryClient };
