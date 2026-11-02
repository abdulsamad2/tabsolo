// TabSolo licensing + telemetry API, deployed to Cloudflare Workers.
//
// Endpoints:
//   POST /api/license/activate   — redeem a key + bind this device (returns a signed token)
//   POST /api/license/validate   — periodic re-check (returns ok + plan)
//   POST /api/license/deactivate — free this computer's slot
//   POST /api/telemetry/event    — one usage event, fire-and-forget
//   POST /api/telemetry/error    — one error report, fire-and-forget
//   GET  /admin/licenses         — admin-only: list all licenses (needs Bearer <ADMIN_TOKEN>)
//   GET  /admin/activations      — admin-only: every computer using a license
//   POST /admin/license          — admin-only: issue a license
//   POST /admin/revoke           — admin-only: revoke a license or a single device activation
//   POST /admin/plan-end         — admin-only: set the date a whole plan (e.g. the free beta) stops working
//   GET  /admin/plan-ends        — admin-only: the plans with an end date
//   POST /admin/license/update   — admin-only: restore a revoked license or change its device limit
//   GET  /admin/telemetry        — admin-only: recent errors and the week's top events, as JSON
//   GET  /admin/dashboard        — admin-only: minimal HTML dashboard (recent errors + events)
//
// Signed activation token (returned by /activate, cached by the client, re-sent on /validate):
//   base64url(json({ k: licenseKey, d: deviceId, p: plan, iat: ms, exp: ms })) + "." + base64url(ed25519 signature)
// The client re-sends the token on /validate so the server can refuse revoked ones immediately. The app
// holds the public key, so it can check a token offline but can't extend or forge one.

import { Hono } from 'hono';
import { cors } from 'hono/cors';

type Env = {
  DB: D1Database;
  ADMIN_TOKEN: string;
  TOKEN_SIGNING_JWK: string;
  APP_NAME: string;
  GRACE_PERIOD_MS: string;
};

const app = new Hono<{ Bindings: Env }>();
// CORS only on the public client API. /admin/* has no CORS so a stolen admin token in a browser
// context can't be used from an arbitrary origin.
app.use('/api/*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'] }));
app.get('/', (c) => c.text(`${c.env.APP_NAME} API — ok`));

// ───────────────────────────────────────────────── helpers

const b64url = {
  encode: (data: Uint8Array | string): string => {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode: (text: string): string => {
    const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
    return atob(b64);
  },
};

function b64urlToBytes(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importTokenKey(env: Env, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  if (!env.TOKEN_SIGNING_JWK) throw new Error('TOKEN_SIGNING_JWK is not set');
  const { kty, crv, x, d } = JSON.parse(env.TOKEN_SIGNING_JWK);
  return crypto.subtle.importKey('jwk', usage === 'sign' ? { kty, crv, x, d } : { kty, crv, x }, 'Ed25519', false, [usage]);
}

async function makeToken(env: Env, payload: Record<string, unknown>): Promise<string> {
  const body = b64url.encode(JSON.stringify(payload));
  const sig = await crypto.subtle.sign('Ed25519', await importTokenKey(env, 'sign'), new TextEncoder().encode(body));
  return `${body}.${b64url.encode(new Uint8Array(sig))}`;
}

async function verifyToken(env: Env, token: string): Promise<Record<string, unknown> | null> {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  let sigBytes: Uint8Array;
  try { sigBytes = b64urlToBytes(sig); } catch { return null; }
  const ok = await crypto.subtle.verify('Ed25519', await importTokenKey(env, 'verify'), sigBytes as BufferSource, new TextEncoder().encode(body));
  if (!ok) return null;
  try { return JSON.parse(b64url.decode(body)); } catch { return null; }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function requireAdmin(c: any): Response | null {
  const auth = c.req.header('authorization') || '';
  const expected = `Bearer ${c.env.ADMIN_TOKEN}`;
  if (!c.env.ADMIN_TOKEN || !constantTimeEqual(auth, expected)) {
    return new Response('forbidden', { status: 403 });
  }
  return null;
}

function badRequest(message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
}

// ───────────────────────────────────────────────── license endpoints

const LICENSE_WITH_PLAN_END = 'SELECT l.*, p.ends_at AS plan_ends_at FROM licenses l LEFT JOIN plan_ends p ON p.plan = l.plan WHERE l.key = ?';

// A token never outlives its license or plan, so going offline can't stretch past the end date.
function tokenExpiry(env: Env, license: any, iat: number): number {
  return Math.min(iat + Number(env.GRACE_PERIOD_MS), license.expires_at || Infinity, license.plan_ends_at || Infinity);
}

// Activate a license on this device. Body: { key, deviceId, deviceLabel, appVersion }.
// Enforces max_devices and returns a signed token the client caches.
app.post('/api/license/activate', async (c) => {
  const body = await c.req.json<any>().catch(() => null);
  if (!body?.key || !body?.deviceId) return badRequest('key and deviceId required');

  const license = await c.env.DB
    .prepare(LICENSE_WITH_PLAN_END)
    .bind(String(body.key).trim())
    .first<any>();

  if (!license) return c.json({ ok: false, error: 'invalid_key' }, 404);
  const refused = licenseError(license);
  if (refused) return c.json({ ok: false, error: refused }, 403);

  // Does this device already have an active activation on this license? Then re-use.
  const existing = await c.env.DB
    .prepare('SELECT * FROM activations WHERE license_key = ? AND device_id = ? AND revoked_at IS NULL')
    .bind(license.key, body.deviceId)
    .first<any>();

  if (!existing) {
    // Guarded INSERT: the row only lands if the current count of active activations is still
    // below max_devices. Two concurrent activations on a solo license race the subquery here,
    // and only one wins — the other sees `meta.changes === 0` and is refused.
    const insert = await c.env.DB
      .prepare(
        'INSERT INTO activations (license_key, device_id, device_label, app_version) ' +
        'SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM activations WHERE license_key = ? AND revoked_at IS NULL) < ? ' +
        // A revoked computer keeps its row, so coming back must revive it rather than hit the primary key.
        'ON CONFLICT (license_key, device_id) DO UPDATE SET revoked_at = NULL, activated_at = unixepoch() * 1000',
      )
      .bind(license.key, body.deviceId, body.deviceLabel || null, body.appVersion || null, license.key, license.max_devices)
      .run();
    if (!insert.meta?.changes) {
      return c.json({ ok: false, error: 'device_limit_reached', max_devices: license.max_devices }, 403);
    }
  } else {
    await c.env.DB
      .prepare('UPDATE activations SET last_seen_at = ?, app_version = ? WHERE license_key = ? AND device_id = ?')
      .bind(Date.now(), body.appVersion || existing.app_version, license.key, body.deviceId)
      .run();
  }

  const iat = Date.now();
  const token = await makeToken(c.env, {
    k: license.key,
    d: body.deviceId,
    p: license.plan,
    iat,
    exp: tokenExpiry(c.env, license, iat),
  });

  return c.json({
    ok: true,
    token,
    plan: license.plan,
    email: license.email,
    expiresAt: license.expires_at,
    gracePeriodMs: Number(c.env.GRACE_PERIOD_MS),
  });
});

// Re-validate on launch and periodically. Body: { token }. Returns ok + plan or an error reason.
function licenseError(license: any): string | null {
  if (!license || license.status !== 'active') return 'revoked';
  if (license.plan_ends_at && license.plan_ends_at <= Date.now()) return 'plan_ended';
  if (license.expires_at && license.expires_at < Date.now()) return 'expired';
  return null;
}

function hasValidClaims(claims: any): claims is { k: string; d: string } {
  return !!claims && typeof claims.k === 'string' && typeof claims.d === 'string';
}

app.post('/api/license/validate', async (c) => {
  const body = await c.req.json<any>().catch(() => null);
  if (!body?.token) return badRequest('token required');

  const claims = await verifyToken(c.env, body.token);
  if (!hasValidClaims(claims)) {
    return c.json({ ok: false, error: 'invalid_token' }, 401);
  }
  // A license file copied to another computer carries the first computer's id.
  // shortcut: builds before 0.1.0-beta.3 don't send deviceId and pass here, make it required once they're gone.
  if (body.deviceId && body.deviceId !== claims.d) {
    return c.json({ ok: false, error: 'device_mismatch' }, 403);
  }

  const license = await c.env.DB
    .prepare(LICENSE_WITH_PLAN_END)
    .bind(claims.k)
    .first<any>();
  const licErr = licenseError(license);
  if (licErr) return c.json({ ok: false, error: licErr }, 403);

  const act = await c.env.DB
    .prepare('SELECT * FROM activations WHERE license_key = ? AND device_id = ? AND revoked_at IS NULL')
    .bind(claims.k, claims.d)
    .first<any>();
  if (!act) return c.json({ ok: false, error: 'device_revoked' }, 403);

  await c.env.DB
    .prepare('UPDATE activations SET last_seen_at = ? WHERE license_key = ? AND device_id = ?')
    .bind(Date.now(), claims.k, claims.d)
    .run();

  // Issue a fresh token with a bumped expiry so the client's offline grace window stays rolling.
  const iat = Date.now();
  const token = await makeToken(c.env, { k: license.key, d: claims.d, p: license.plan, iat, exp: tokenExpiry(c.env, license, iat) });
  return c.json({ ok: true, token, plan: license.plan, email: license.email, expiresAt: license.expires_at });
});

// Frees this computer's slot, from the app itself. Body: { token, deviceId }.
app.post('/api/license/deactivate', async (c) => {
  const body = await c.req.json<any>().catch(() => null);
  if (!body?.token || !body?.deviceId) return badRequest('token and deviceId required');
  const claims = await verifyToken(c.env, body.token);
  if (!hasValidClaims(claims)) return c.json({ ok: false, error: 'invalid_token' }, 401);
  if (body.deviceId !== claims.d) return c.json({ ok: false, error: 'device_mismatch' }, 403);
  await c.env.DB
    .prepare('UPDATE activations SET revoked_at = ? WHERE license_key = ? AND device_id = ? AND revoked_at IS NULL')
    .bind(Date.now(), claims.k, claims.d)
    .run();
  return c.json({ ok: true });
});

// ───────────────────────────────────────────────── telemetry endpoints

// Checks the signed token on a telemetry request. Trusts licenseKey + deviceId from the token
// claims rather than the body, so a scanner can't flood the DB or spoof another user's license key.
async function authTelemetry(c: any, body: any): Promise<Record<string, unknown> | Response> {
  if (!body?.token) return new Response(JSON.stringify({ ok: false, error: 'token_required' }), { status: 401, headers: { 'content-type': 'application/json' } });
  const claims = await verifyToken(c.env, String(body.token));
  if (!claims || typeof claims.k !== 'string' || typeof claims.d !== 'string') {
    return new Response(JSON.stringify({ ok: false, error: 'invalid_token' }), { status: 401, headers: { 'content-type': 'application/json' } });
  }
  if (body.deviceId && String(body.deviceId) !== claims.d) {
    return new Response(JSON.stringify({ ok: false, error: 'device_mismatch' }), { status: 401, headers: { 'content-type': 'application/json' } });
  }
  return claims;
}

app.post('/api/telemetry/event', async (c) => {
  const body = await c.req.json<any>().catch(() => null);
  if (!body?.name) return badRequest('name required');
  const auth = await authTelemetry(c, body);
  if (auth instanceof Response) return auth;
  await c.env.DB
    .prepare(
      'INSERT INTO telemetry_events (device_id, license_key, app_version, os, name, props) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(
      String(auth.d).slice(0, 128),
      String(auth.k).slice(0, 64),
      body.appVersion ? String(body.appVersion).slice(0, 32) : null,
      body.os ? String(body.os).slice(0, 32) : null,
      String(body.name).slice(0, 64),
      body.props ? JSON.stringify(body.props).slice(0, 4000) : null,
    )
    .run();
  return c.json({ ok: true });
});

app.post('/api/telemetry/error', async (c) => {
  const body = await c.req.json<any>().catch(() => null);
  if (!body?.message) return badRequest('message required');
  const auth = await authTelemetry(c, body);
  if (auth instanceof Response) return auth;
  await c.env.DB
    .prepare(
      'INSERT INTO telemetry_errors (device_id, license_key, app_version, os, kind, message, stack, context) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      String(auth.d).slice(0, 128),
      String(auth.k).slice(0, 64),
      body.appVersion ? String(body.appVersion).slice(0, 32) : null,
      body.os ? String(body.os).slice(0, 32) : null,
      String(body.kind || 'generic').slice(0, 32),
      String(body.message).slice(0, 2000),
      body.stack ? String(body.stack).slice(0, 8000) : null,
      body.context ? JSON.stringify(body.context).slice(0, 4000) : null,
    )
    .run();
  return c.json({ ok: true });
});

// ───────────────────────────────────────────────── admin endpoints

app.get('/admin/licenses', async (c) => {
  const bad = requireAdmin(c); if (bad) return bad;
  const { results } = await c.env.DB
    .prepare(`SELECT l.*, (SELECT COUNT(*) FROM activations a WHERE a.license_key = l.key AND a.revoked_at IS NULL) AS active_devices FROM licenses l ORDER BY l.created_at DESC`)
    .all();
  return c.json({ ok: true, licenses: results });
});

// Every computer currently using a license, for the admin page.
app.get('/admin/activations', async (c) => {
  const bad = requireAdmin(c); if (bad) return bad;
  const { results } = await c.env.DB
    .prepare('SELECT license_key, device_id, device_label, app_version, last_seen_at FROM activations WHERE revoked_at IS NULL ORDER BY last_seen_at DESC')
    .all();
  return c.json({ ok: true, activations: results });
});

// Issue a license. Body: { key, email, plan, max_devices?, expires_at? }.
app.post('/admin/license', async (c) => {
  const bad = requireAdmin(c); if (bad) return bad;
  const body = await c.req.json<any>().catch(() => null);
  if (!body?.key || !body?.email || !body?.plan) return badRequest('key, email, plan required');
  const maxDevices = body.plan === 'pro' ? 3 : body.plan === 'team' ? (body.max_devices || 10) : 1;
  try {
    await c.env.DB
      .prepare('INSERT INTO licenses (key, email, plan, max_devices, expires_at, notes) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(body.key, body.email, body.plan, maxDevices, body.expires_at || null, body.notes || null)
      .run();
  } catch (e: any) {
    return c.json({ ok: false, error: 'duplicate_or_invalid', detail: String(e?.message || e) }, 400);
  }
  return c.json({ ok: true, key: body.key });
});

// Ends a whole plan on a date, for every license on it now or issued later and every app version,
// because the check runs here. Body: { plan, endsAt } with endsAt in unix ms, or null to remove the end.
app.post('/admin/plan-end', async (c) => {
  const bad = requireAdmin(c); if (bad) return bad;
  const body = await c.req.json<any>().catch(() => null);
  if (!body?.plan || (body.endsAt !== null && !Number.isFinite(body.endsAt))) return badRequest('plan and endsAt (ms or null) required');
  if (body.endsAt === null) {
    await c.env.DB.prepare('DELETE FROM plan_ends WHERE plan = ?').bind(body.plan).run();
  } else {
    await c.env.DB
      .prepare('INSERT INTO plan_ends (plan, ends_at) VALUES (?, ?) ON CONFLICT (plan) DO UPDATE SET ends_at = excluded.ends_at')
      .bind(body.plan, body.endsAt)
      .run();
  }
  return c.json({ ok: true, plan: body.plan, endsAt: body.endsAt });
});

const BETA_MAX_DEVICES = 2;

/** TS-XXXX-XXXX-XXXX. 32 symbols (no 0/O/1/I) divide 256 evenly, so every symbol is equally likely. */
function newLicenseKey(): string {
  const symbols = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const chars = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => symbols[b % 32]).join('');
  return `TS-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

// Free beta: returns the email's license, creating it on the first call. Safe to repeat: the
// insert and its NOT EXISTS check are one statement, so two calls at once still make one license.
// Body: { email }.
app.post('/admin/beta-license', async (c) => {
  const bad = requireAdmin(c); if (bad) return bad;
  const body = await c.req.json<any>().catch(() => null);
  const email = String(body?.email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return badRequest('valid email required');
  await c.env.DB
    .prepare("INSERT INTO licenses (key, email, plan, max_devices) SELECT ?, ?, 'beta', ? WHERE NOT EXISTS (SELECT 1 FROM licenses WHERE lower(email) = ?)")
    .bind(newLicenseKey(), email, BETA_MAX_DEVICES, email)
    .run();
  const license = await c.env.DB
    .prepare(`SELECT l.key, l.plan, l.status, l.max_devices, l.created_at,
      (SELECT COUNT(*) FROM activations a WHERE a.license_key = l.key AND a.revoked_at IS NULL) AS active_devices
      FROM licenses l WHERE lower(l.email) = ? ORDER BY l.created_at LIMIT 1`)
    .bind(email)
    .first();
  return c.json({ ok: true, license });
});

// Revoke. Body: { key, deviceId? }. Without deviceId, revokes the whole license.
app.post('/admin/revoke', async (c) => {
  const bad = requireAdmin(c); if (bad) return bad;
  const body = await c.req.json<any>().catch(() => null);
  if (!body?.key) return badRequest('key required');
  if (body.deviceId) {
    await c.env.DB
      .prepare('UPDATE activations SET revoked_at = ? WHERE license_key = ? AND device_id = ?')
      .bind(Date.now(), body.key, body.deviceId)
      .run();
  } else {
    await c.env.DB.prepare('UPDATE licenses SET status = ? WHERE key = ?').bind('revoked', body.key).run();
    await c.env.DB
      .prepare('UPDATE activations SET revoked_at = ? WHERE license_key = ? AND revoked_at IS NULL')
      .bind(Date.now(), body.key)
      .run();
  }
  return c.json({ ok: true });
});

// Minimal HTML dashboard — recent events + errors + license summary.
app.get('/admin/plan-ends', async (c) => {
  const bad = requireAdmin(c); if (bad) return bad;
  const { results } = await c.env.DB.prepare('SELECT plan, ends_at FROM plan_ends').all();
  return c.json({ ok: true, planEnds: results });
});

// Body: { key, status?: 'active' | 'revoked', max_devices?: 1-100 }. Restoring doesn't bring back
// removed computers; they activate again with the key.
app.post('/admin/license/update', async (c) => {
  const bad = requireAdmin(c); if (bad) return bad;
  const body = await c.req.json<any>().catch(() => null);
  const { key, status, max_devices: maxDevices } = body ?? {};
  if (typeof key !== 'string' || !key) return badRequest('key required');
  if (status !== undefined && status !== 'active' && status !== 'revoked') return badRequest('status must be active or revoked');
  if (maxDevices !== undefined && (!Number.isInteger(maxDevices) || maxDevices < 1 || maxDevices > 100)) return badRequest('max_devices must be 1-100');
  if (status === undefined && maxDevices === undefined) return badRequest('nothing to update');
  const { meta } = await c.env.DB
    .prepare('UPDATE licenses SET status = COALESCE(?, status), max_devices = COALESCE(?, max_devices) WHERE key = ?')
    .bind(status ?? null, maxDevices ?? null, key)
    .run();
  if (!meta.changes) return c.json({ ok: false, error: 'not_found' }, 404);
  return c.json({ ok: true });
});

app.get('/admin/telemetry', async (c) => {
  const bad = requireAdmin(c); if (bad) return bad;
  const [errors, events] = await Promise.all([
    c.env.DB.prepare('SELECT id, kind, message, app_version, os, created_at FROM telemetry_errors ORDER BY created_at DESC LIMIT 50').all(),
    c.env.DB.prepare('SELECT name, COUNT(*) AS n FROM telemetry_events WHERE created_at > ? GROUP BY name ORDER BY n DESC LIMIT 25').bind(Date.now() - 7 * 24 * 3600_000).all(),
  ]);
  return c.json({ ok: true, errors: errors.results, events: events.results });
});

app.get('/admin/dashboard', async (c) => {
  const bad = requireAdmin(c); if (bad) return bad;
  const [licenses, errors, events] = await Promise.all([
    c.env.DB.prepare(`SELECT l.*, (SELECT COUNT(*) FROM activations a WHERE a.license_key = l.key AND a.revoked_at IS NULL) AS n FROM licenses l ORDER BY l.created_at DESC LIMIT 50`).all(),
    c.env.DB.prepare(`SELECT * FROM telemetry_errors ORDER BY created_at DESC LIMIT 50`).all(),
    c.env.DB.prepare(`SELECT name, COUNT(*) AS n FROM telemetry_events WHERE created_at > ? GROUP BY name ORDER BY n DESC LIMIT 25`).bind(Date.now() - 7 * 24 * 3600_000).all(),
  ]);

  const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]);
  const html = `<!doctype html><html><head><meta charset=utf-8><title>TabSolo admin</title>
<style>
body{background:#0a0b0f;color:#eef1f6;font:14px/1.5 -apple-system,system-ui,sans-serif;max-width:1100px;margin:40px auto;padding:0 20px}
h1,h2{letter-spacing:-.02em}h1{font-size:24px}h2{font-size:16px;color:#9aa3b2;margin-top:30px}
table{width:100%;border-collapse:collapse;margin:8px 0 20px;background:#121620;border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #22283a;font-size:13px}
th{background:#171c25;color:#9aa3b2;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.06em}
tr:last-child td{border-bottom:none}code{background:#171c25;padding:1px 6px;border-radius:4px;color:#a4b1ff;font:12px ui-monospace,Menlo,monospace}
.pill{display:inline-block;padding:2px 8px;border-radius:100px;font-size:11px;font-weight:600}
.pill-ok{background:rgba(21,128,61,.2);color:#7bd297}.pill-bad{background:rgba(201,28,28,.2);color:#f5caca}
</style></head><body>
<h1>TabSolo admin</h1>
<h2>Licenses (${licenses.results?.length ?? 0})</h2>
<table><tr><th>Key</th><th>Email</th><th>Plan</th><th>Devices</th><th>Status</th><th>Issued</th></tr>
${(licenses.results || []).map((r: any) => `<tr><td><code>${esc(r.key)}</code></td><td>${esc(r.email)}</td><td>${esc(r.plan)}</td><td>${esc(r.n)} / ${esc(r.max_devices)}</td><td><span class="pill ${r.status === 'active' ? 'pill-ok' : 'pill-bad'}">${esc(r.status)}</span></td><td>${new Date(r.created_at).toISOString().slice(0, 10)}</td></tr>`).join('')}
</table>
<h2>Top events, last 7 days</h2>
<table><tr><th>Event</th><th>Count</th></tr>${(events.results || []).map((r: any) => `<tr><td><code>${esc(r.name)}</code></td><td>${esc(r.n)}</td></tr>`).join('')}</table>
<h2>Recent errors (50)</h2>
<table><tr><th>When</th><th>Kind</th><th>Message</th><th>Version</th></tr>${(errors.results || []).map((r: any) => `<tr><td>${new Date(r.created_at).toISOString().slice(0, 19).replace('T', ' ')}</td><td><span class="pill pill-bad">${esc(r.kind)}</span></td><td>${esc(r.message)}</td><td><code>${esc(r.app_version || '?')}</code></td></tr>`).join('')}</table>
</body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
});

export default app;
