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

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getDeviceId, getDeviceLabel } = require('./device');

const DEFAULT_API_BASE = 'https://tabsolo-api.abdulsamad-laghari1.workers.dev';
const TOKEN_FILE_BASENAME = 'license.json';
const TOKEN_PUBLIC_KEY = crypto.createPublicKey({
  key: { kty: 'OKP', crv: 'Ed25519', x: '9k3xBUvLkCAC-ZWfZz0bHQWhTKcAP1VrO3FCirmELqA' },
  format: 'jwk',
});

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

// The token's signature, checked with the public half of the server's key. The app can read a token but
// can't extend or forge one, which is what stops editing the expiry and blocking the license server.
function readToken(token, publicKey = TOKEN_PUBLIC_KEY) {
  try {
    const [body, sig] = token.split('.');
    if (!crypto.verify(null, Buffer.from(body), publicKey, Buffer.from(sig, 'base64url'))) return null;
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return claims?.exp ? claims : null;
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

function createLicenseClient({ apiBase = DEFAULT_API_BASE, dataDir, appVersion, publicKey = TOKEN_PUBLIC_KEY }) {
  const base = (apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
  const deviceId = getDeviceId();
  const deviceLabel = getDeviceLabel();

  // Refuses anything not signed by our server for this computer, including a fake server's approval.
  const isOurs = (token) => readToken(token, publicKey)?.d === deviceId;

  async function activate(key) {
    const trimmed = (key || '').trim().toUpperCase();
    if (!trimmed) return { ok: false, error: 'empty_key' };
    const { ok, status, data } = await postJson(`${base}/api/license/activate`, {
      key: trimmed, deviceId, deviceLabel, appVersion,
    });
    if (!ok || !data?.ok) {
      console.warn('[license] activation failed:', status, data?.error || 'unknown');
      return { ok: false, error: data?.error || 'activation_failed', detail: data };
    }
    if (!isOurs(data.token)) return { ok: false, error: 'activation_failed' };
    writeCache(dataDir, { token: data.token, plan: data.plan, email: data.email, licenseKey: trimmed, cachedAt: Date.now() });
    return { ok: true, plan: data.plan, email: data.email };
  }

  // Called at startup. Returns one of:
  //   { ok: true,  plan, email, source: 'server' | 'cache' }
  //   { ok: false, reason: 'no_license' | 'expired_offline' | 'revoked' | 'device_revoked' | 'device_mismatch' | 'invalid_token' | 'plan_ended' | 'expired' | 'network_error' }
  async function validateAtStartup() {
    const cached = readCache(dataDir);
    if (!cached?.token) return { ok: false, reason: 'no_license' };

    const claims = readToken(cached.token, publicKey);
    const now = Date.now();

    if (!claims) {
      clearCache(dataDir);
      return { ok: false, reason: 'invalid_token' };
    }
    // Without this, a license file copied from another computer would run here using that computer's slot.
    if (claims.d !== deviceId) {
      clearCache(dataDir);
      return { ok: false, reason: 'device_mismatch' };
    }

    // Try the server. If network is up, the server's answer wins.
    const { ok, status, data } = await postJson(`${base}/api/license/validate`, { token: cached.token, deviceId }, 6000);
    if (ok && data?.ok && isOurs(data.token)) {
      writeCache(dataDir, { ...cached, token: data.token, plan: data.plan, email: data.email, cachedAt: Date.now() });
      return { ok: true, plan: data.plan, email: data.email, source: 'server' };
    }

    // Server answered with an explicit refusal — trust it, burn the cache.
    if (status >= 400 && status < 500 && data?.error) {
      clearCache(dataDir);
      return { ok: false, reason: data.error };
    }

    // Network error or 5xx: fall back to the cached token until it expires, which forces a check-in.
    // shortcut: a clock set back to inside the token's window still passes, but a clock before it doesn't.
    if (claims.exp > now && claims.iat <= now + 86_400_000) {
      return { ok: true, plan: cached.plan, email: cached.email, source: 'cache' };
    }
    return { ok: false, reason: 'expired_offline' };
  }

  // Keeps the local license if the server can't be reached: the slot would stay used with no way back.
  async function deactivate() {
    const token = readCache(dataDir)?.token;
    if (!token) return { ok: false, error: 'no_license' };
    const { ok, data } = await postJson(`${base}/api/license/deactivate`, { token, deviceId });
    if (!ok || !data?.ok) return { ok: false, error: data?.error || 'network_error' };
    clearCache(dataDir);
    return { ok: true };
  }

  function currentLicenseKey() { return readCache(dataDir)?.licenseKey || null; }
  function currentPlan() { return readCache(dataDir)?.plan || null; }
  function currentToken() { return readCache(dataDir)?.token || null; }

  return { activate, validateAtStartup, deactivate, currentLicenseKey, currentPlan, currentToken, deviceId, deviceLabel };
}

module.exports = { createLicenseClient, readToken };
