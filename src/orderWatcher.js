'use strict';

// Background poller for Automatiq Sync invoiced orders. Each new order (dedup'd by order id) is
// handed to `onNewOrder` so main.js can open a search tab for it. Dedup state lives on disk so a
// restart doesn't flood the user with every open invoice all over again.
//
// Design notes:
// - Starts manually (watcher is user-opted-in via settings) and stops when the session ends.
// - A single in-flight poll at a time; if a tick overruns the interval, we skip rather than queue.
// - Hard cap on the dedup set to keep seen-orders.json small; oldest IDs age out.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_INTERVAL_MS = 2 * 60 * 1000;
const SEEN_CAP = 2000;

function createOrderWatcher({ seenPath, listOrders, onNewOrder, onError }) {
  let timer = null;
  let polling = false;
  let seen = loadSeen(seenPath);

  async function tick() {
    if (polling) return;
    polling = true;
    try {
      const result = await listOrders({ status: 'invoiced', limit: 25, orderBy: 'created_at', direction: 'desc' });
      if (result?.error) {
        onError?.(result.error);
        return;
      }
      const orders = Array.isArray(result?.orders) ? result.orders : [];
      // Oldest-first so new tabs open in creation order even inside one poll.
      const fresh = orders.filter((o) => o?.id && !seen.has(String(o.id))).reverse();
      let anySeen = false;
      for (const order of fresh) {
        try {
          await onNewOrder(order);
          // Only remember the order once the handler accepted it — a transient failure (window
          // closed mid-poll, OOM, main-process throw) must leave it unseen so the next tick retries.
          seen.add(String(order.id));
          anySeen = true;
        } catch (err) {
          onError?.(err?.message || String(err));
        }
      }
      if (anySeen) saveSeen(seenPath, trim(seen));
    } catch (err) {
      onError?.(err?.message || String(err));
    } finally {
      polling = false;
    }
  }

  return {
    start(intervalMs = DEFAULT_INTERVAL_MS) {
      this.stop();
      // Fire once immediately so a user who just enabled the setting sees activity right away.
      tick();
      timer = setInterval(tick, Math.max(30_000, Number(intervalMs) || DEFAULT_INTERVAL_MS));
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
    isRunning() { return timer !== null; },
    /** Marks every currently-visible order as seen without opening any tab. Useful on first enable. */
    async primeSeen() {
      const result = await listOrders({ status: 'invoiced', limit: 50 }).catch(() => null);
      if (!result?.orders) return;
      for (const o of result.orders) if (o?.id) seen.add(String(o.id));
      saveSeen(seenPath, trim(seen));
    },
  };
}

function loadSeen(seenPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(seenPath, 'utf8'));
    if (Array.isArray(raw)) return new Set(raw.map(String));
  } catch {}
  return new Set();
}

function saveSeen(seenPath, set) {
  try {
    fs.mkdirSync(path.dirname(seenPath), { recursive: true });
    const tmp = `${seenPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...set]));
    fs.renameSync(tmp, seenPath);
  } catch {}
}

function trim(set) {
  if (set.size <= SEEN_CAP) return set;
  // Set iteration is insertion order; drop the oldest entries first.
  const extra = set.size - SEEN_CAP;
  let i = 0;
  for (const key of set) {
    if (i++ >= extra) break;
    set.delete(key);
  }
  return set;
}

module.exports = { createOrderWatcher, DEFAULT_INTERVAL_MS };
