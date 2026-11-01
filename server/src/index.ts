// TabFleet licensing + telemetry API, deployed to Cloudflare Workers.
//
// Endpoints:
//   POST /api/license/activate   — redeem a key + bind this device (returns a signed token)
//   POST /api/license/validate   — periodic re-check (returns ok + plan)
//   POST /api/telemetry/event    — one usage event, fire-and-forget
//   POST /api/telemetry/error    — one error report, fire-and-forget
//   GET  /admin/licenses         — admin-only: list all licenses (needs Bearer <ADMIN_TOKEN>)
//   POST /admin/license          — admin-only: issue a license
//   POST /admin/revoke           — admin-only: revoke a license or a single device activation
//   GET  /admin/dashboard        — admin-only: minimal HTML dashboard (recent errors + events)
//
// Signed activation token (returned by /activate, cached by the client, re-sent on /validate):
//   base64url(json({ k: licenseKey, d: deviceId, p: plan, iat: ms, exp: ms })) + "." + base64url(hmac)
// The client re-sends the token on /validate so the server can refuse revoked ones immediately.

import { Hono } from 'hono';
import { cors } from 'hono/cors';

type Env = {
  DB: D1Database;
  ADMIN_TOKEN: string;
  HMAC_SECRET: string;
  APP_NAME: string;
  GRACE_PERIOD_MS: string;
};

const app = new Hono<{ Bindings: Env }>();
app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'] }));
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

async function hmacSign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return b64url.encode(new Uint8Array(sig));
}

async function makeToken(env: Env, payload: Record<string, unknown>): Promise<string> {
  const body = b64url.encode(JSON.stringify(payload));
  const sig = await hmacSign(env.HMAC_SECRET, body);
  return `${body}.${sig}`;
}

async function verifyToken(env: Env, token: string): Promise<Record<string, unknown> | null> {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = await hmacSign(env.HMAC_SECRET, body);
  if (expected !== sig) return null;
  try { return JSON.parse(b64url.decode(body)); } catch { return null; }
}

function requireAdmin(c: any): Response | null {
  const auth = c.req.header('authorization') || '';
  const expected = `Bearer ${c.env.ADMIN_TOKEN}`;
  if (auth !== expected || !c.env.ADMIN_TOKEN) {
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

// Activate a license on this device. Body: { key, deviceId, deviceLabel, appVersion }.
// Enforces max_devices and returns a signed token the client caches.
app.post('/api/license/activate', async (c) => {
  const body = await c.req.json<any>().catch(() => null);
  if (!body?.key || !body?.deviceId) return badRequest('key and deviceId required');

  const license = await c.env.DB
    .prepare('SELECT * FROM licenses WHERE key = ?')
    .bind(String(body.key).trim())
    .first<any>();

  if (!license) return c.json({ ok: false, error: 'invalid_key' }, 404);
  if (license.status !== 'active') return c.json({ ok: false, error: license.status }, 403);
  if (license.expires_at && license.expires_at < Date.now()) return c.json({ ok: false, error: 'expired' }, 403);

  // Does this device already have an active activation on this license? Then re-use.
  const existing = await c.env.DB
    .prepare('SELECT * FROM activations WHERE license_key = ? AND device_id = ? AND revoked_at IS NULL')
    .bind(license.key, body.deviceId)
    .first<any>();

  if (!existing) {
    // Count active activations on this license.
    const count = await c.env.DB
      .prepare('SELECT COUNT(*) AS n FROM activations WHERE license_key = ? AND revoked_at IS NULL')
      .bind(license.key)
      .first<any>();
    if (count && count.n >= license.max_devices) {
      return c.json({ ok: false, error: 'device_limit_reached', max_devices: license.max_devices }, 403);
    }
    await c.env.DB
      .prepare(
        'INSERT INTO activations (license_key, device_id, device_label, app_version) VALUES (?, ?, ?, ?)',
      )
      .bind(license.key, body.deviceId, body.deviceLabel || null, body.appVersion || null)
      .run();
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
    exp: iat + Number(c.env.GRACE_PERIOD_MS),
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
app.post('/api/license/validate', async (c) => {
  const body = await c.req.json<any>().catch(() => null);
  if (!body?.token) return badRequest('token required');

  const claims = await verifyToken(c.env, body.token);
  if (!claims || typeof claims.k !== 'string' || typeof claims.d !== 'string') {
    return c.json({ ok: false, error: 'invalid_token' }, 401);
  }

  const license = await c.env.DB
    .prepare('SELECT * FROM licenses WHERE key = ?')
    .bind(claims.k)
    .first<any>();
  if (!license || license.status !== 'active') return c.json({ ok: false, error: 'revoked' }, 403);
  if (license.expires_at && license.expires_at < Date.now()) return c.json({ ok: false, error: 'expired' }, 403);

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
  const token = await makeToken(c.env, { k: license.key, d: claims.d, p: license.plan, iat, exp: iat + Number(c.env.GRACE_PERIOD_MS) });
  return c.json({ ok: true, token, plan: license.plan, email: license.email, expiresAt: license.expires_at });
});

// ───────────────────────────────────────────────── telemetry endpoints

app.post('/api/telemetry/event', async (c) => {
  const body = await c.req.json<any>().catch(() => null);
  if (!body?.deviceId || !body?.name) return badRequest('deviceId and name required');
  await c.env.DB
    .prepare(
      'INSERT INTO telemetry_events (device_id, license_key, app_version, os, name, props) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(
      String(body.deviceId).slice(0, 128),
      body.licenseKey ? String(body.licenseKey).slice(0, 64) : null,
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
  if (!body?.deviceId || !body?.message) return badRequest('deviceId and message required');
  await c.env.DB
    .prepare(
      'INSERT INTO telemetry_errors (device_id, license_key, app_version, os, kind, message, stack, context) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      String(body.deviceId).slice(0, 128),
      body.licenseKey ? String(body.licenseKey).slice(0, 64) : null,
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
app.get('/admin/dashboard', async (c) => {
  const bad = requireAdmin(c); if (bad) return bad;
  const [licenses, errors, events] = await Promise.all([
    c.env.DB.prepare(`SELECT l.*, (SELECT COUNT(*) FROM activations a WHERE a.license_key = l.key AND a.revoked_at IS NULL) AS n FROM licenses l ORDER BY l.created_at DESC LIMIT 50`).all(),
    c.env.DB.prepare(`SELECT * FROM telemetry_errors ORDER BY created_at DESC LIMIT 50`).all(),
    c.env.DB.prepare(`SELECT name, COUNT(*) AS n FROM telemetry_events WHERE created_at > ? GROUP BY name ORDER BY n DESC LIMIT 25`).bind(Date.now() - 7 * 24 * 3600_000).all(),
  ]);

  const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]);
  const html = `<!doctype html><html><head><meta charset=utf-8><title>TabFleet admin</title>
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
<h1>TabFleet admin</h1>
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
