'use strict';

// License client. Talks to the Workers API to activate + validate, and caches the signed token
// so the app keeps working offline up to the grace period (7 days by default).
//
// Flow:
//   1. On launch: load cached token from disk. If present and not expired, verify locally for UI
//      snappiness, then kick off an async /validate to refresh. If network is down, the cached
//      token keeps the app running until its exp.
//   2. If no cached token: show the login window, call /activate with the user's key + this
//      device's fingerprint, save the returned token.
//   3. Periodic /validate every 6h picks up server-side revocations.

const fs = require('fs');
const path = require('path');
const { getDeviceId, getDeviceLabel } = require('./device');

const DEFAULT_API_BASE = 'https://tabfleet-api.abdulsamad-laghari1.workers.dev';
const TOKEN_FILE_BASENAME = 'license.json';

function tokenFile(dataDir) { return path.join(dataDir, TOKEN_FILE_BASENAME); }

function readCache(dataDir) {
  try {
    const raw = fs.readFileSync(tokenFile(dataDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.token !== 'string') return null;
    return parsed;
  } catch { return null; }
}

function writeCache(dataDir, data) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(tokenFile(dataDir), JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch (err) {
    console.warn('[license] failed to write cache:', err?.message);
  }
}

function clearCache(dataDir) {
  try { fs.unlinkSync(tokenFile(dataDir)); } catch { /* ignore */ }
}

// Local sanity check — decodes the token body without verifying the HMAC (server does that on
// every /validate). Used to decide if we should let the user in while offline.
function peekToken(token) {
  try {
    const [body] = token.split('.');
    if (!body) return null;
    const padded = body.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((body.length + 3) % 4);
    const claims = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    if (!claims || !claims.exp) return null;
    return claims;
  } catch { return null; }
}

async function postJson(url, body, timeoutMs = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { error: String(err?.name || 'network_error') } };
  } finally {
    clearTimeout(timer);
  }
}

function createLicenseClient({ apiBase = DEFAULT_API_BASE, dataDir, appVersion }) {
  const base = (apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
  const deviceId = getDeviceId();
  const deviceLabel = getDeviceLabel();

  async function activate(key) {
    const trimmed = (key || '').trim();
    if (!trimmed) return { ok: false, error: 'empty_key' };
    const { ok, data } = await postJson(`${base}/api/license/activate`, {
      key: trimmed, deviceId, deviceLabel, appVersion,
    });
    if (!ok || !data?.ok) return { ok: false, error: data?.error || 'activation_failed', detail: data };
    writeCache(dataDir, { token: data.token, plan: data.plan, email: data.email, licenseKey: trimmed, cachedAt: Date.now() });
    return { ok: true, plan: data.plan, email: data.email };
  }

  // Called at startup. Returns one of:
  //   { ok: true,  plan, email, source: 'server' | 'cache' }
  //   { ok: false, reason: 'no_license' | 'expired_offline' | 'revoked' | 'device_revoked' | 'expired' | 'network_error' }
  async function validateAtStartup() {
    const cached = readCache(dataDir);
    if (!cached?.token) return { ok: false, reason: 'no_license' };

    const claims = peekToken(cached.token);
    const now = Date.now();

    // Try the server. If network is up, the server's answer wins.
    const { ok, status, data } = await postJson(`${base}/api/license/validate`, { token: cached.token }, 6000);
    if (ok && data?.ok) {
      writeCache(dataDir, { ...cached, token: data.token, plan: data.plan, email: data.email, cachedAt: Date.now() });
      return { ok: true, plan: data.plan, email: data.email, source: 'server' };
    }

    // Server answered with an explicit refusal — trust it, burn the cache.
    if (status >= 400 && status < 500 && data?.error) {
      clearCache(dataDir);
      return { ok: false, reason: data.error };
    }

    // Network error or 5xx — fall back to the cached token if it hasn't expired yet.
    if (claims && claims.exp && claims.exp > now) {
      return { ok: true, plan: cached.plan, email: cached.email, source: 'cache' };
    }
    return { ok: false, reason: 'expired_offline' };
  }

  function deactivate() { clearCache(dataDir); }

  function currentLicenseKey() { return readCache(dataDir)?.licenseKey || null; }
  function currentPlan() { return readCache(dataDir)?.plan || null; }

  return { activate, validateAtStartup, deactivate, currentLicenseKey, currentPlan, deviceId, deviceLabel };
}

module.exports = { createLicenseClient };
