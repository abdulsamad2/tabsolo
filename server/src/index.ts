// TabSolo licensing + telemetry API, deployed to Cloudflare Workers.
//
// Endpoints:
//   POST /api/license/activate   — redeem a key + bind this device (returns a signed token)
//   POST /api/license/validate   — periodic re-check (returns ok + plan)
//   POST /api/license/deactivate — free this computer's slot
//   POST /api/billing/checkout   — a Polar checkout link plus the license key it will pay for
//   POST /api/billing/portal     — a Polar customer portal link for the caller's subscription
//   GET  /billing/done           — the page Polar sends the customer to after checkout
//   POST /webhooks/polar         — Polar's subscription events; keeps the subscription's license in step
//   POST /api/telemetry/event    — one usage event, fire-and-forget
//   POST /api/telemetry/error    — one error report, fire-and-forget
//   GET  /admin/licenses         — admin-only: list all licenses (needs Bearer <ADMIN_TOKEN>)
//   GET  /admin/license?email=   — admin-only: the license the website shows on that account's page
//   POST /admin/checkout         — admin-only: a Polar checkout link for a website account
//   POST /admin/portal           — admin-only: a Polar customer portal link for a license
//   GET  /admin/activations      — admin-only: every computer using a license
//   POST /admin/license          — admin-only: issue a license
//   POST /admin/revoke           — admin-only: revoke a license or a single device activation
//   POST /admin/plan-end         — admin-only: set the date a whole plan (e.g. the free beta) stops working
//   GET  /admin/plan-ends        — admin-only: the plans with an end date
//   POST /admin/license/update   — admin-only: restore a revoked license or change its device limit
//   GET  /admin/telemetry        — admin-only: recent errors and events, as JSON; ?key= for one license
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
  POLAR_API: string;
  POLAR_PRODUCT_ID: string;
  POLAR_ACCESS_TOKEN: string;
  POLAR_WEBHOOK_SECRET: string;
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

// ───────────────────────────────────────────────── billing (Polar)
// Polar owns the subscription, its free trial and the payments. A license row mirrors each subscription,
// so activation, the device limit and offline tokens work exactly as for a hand-issued key.
// The app asks for a checkout link and gets a new key with it; the key starts working when Polar's
// webhook reports the subscription, which is what the app waits for.

// The plan name follows the seats: one computer is "solo", more is "team".
const planFor = (seats: number) => (seats > 1 ? 'team' : 'solo');
// Past the paid period, so a late renewal webhook doesn't lock out a paying customer.
const RENEWAL_SLACK_MS = 3 * 24 * 3600_000;
const LICENSE_KEY = /^TS(-[A-Z2-9]{4}){3}$/;

async function polar(env: Env, path: string, body: unknown): Promise<any> {
  const res = await fetch(env.POLAR_API + path, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.POLAR_ACCESS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Polar ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// The trial comes from the product's settings in Polar, which also refuses a second trial to the same customer.
// With an email (a website account), the license shows on that account's page whatever email is typed at checkout.
async function createCheckout(env: Env, successUrl: (key: string) => string, email?: string): Promise<{ url: string; key: string }> {
  const key = newLicenseKey();
  const checkout = await polar(env, '/v1/checkouts/', {
    products: [env.POLAR_PRODUCT_ID],
    // Polar copies this to the subscription, which is how the webhook knows the key and the account.
    metadata: { license_key: key, ...(email && { account_email: email }) },
    customer_email: email,
    success_url: successUrl(key),
  });
  return { url: checkout.url, key };
}

const billingOff = (env: Env) => !env.POLAR_ACCESS_TOKEN || !env.POLAR_PRODUCT_ID;

app.post('/api/billing/checkout', async (c) => {
  if (billingOff(c.env)) return c.json({ ok: false, error: 'billing_unavailable' }, 503);
  const origin = new URL(c.req.url).origin;
  return c.json({ ok: true, ...(await createCheckout(c.env, (key) => `${origin}/billing/done?key=${key}`)) });
});

// The website's checkout. Body: { email, successUrl }. Admin-only because the caller picks where the
// customer lands after paying and which account gets the license.
app.post('/admin/checkout', async (c) => {
  const bad = requireAdmin(c); if (bad) return bad;
  const body = await c.req.json<any>().catch(() => null);
  const email = String(body?.email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^https?:\/\//.test(body?.successUrl)) return badRequest('email and successUrl required');
  if (billingOff(c.env)) return c.json({ ok: false, error: 'billing_unavailable' }, 503);
  return c.json({ ok: true, url: (await createCheckout(c.env, () => body.successUrl, email)).url });
});

// Body: { key, returnUrl? }.
app.post('/admin/portal', async (c) => {
  const bad = requireAdmin(c); if (bad) return bad;
  const body = await c.req.json<any>().catch(() => null);
  const license = await c.env.DB.prepare('SELECT polar_customer_id FROM licenses WHERE key = ?').bind(String(body?.key ?? '')).first<any>();
  if (!license?.polar_customer_id) return c.json({ ok: false, error: 'no_subscription' }, 404);
  const session = await polar(c.env, '/v1/customer-sessions/', { customer_id: license.polar_customer_id, return_url: body.returnUrl });
  return c.json({ ok: true, url: session.customer_portal_url });
});

// Shows the key in the browser too, in case the app was closed before the payment went through.
app.get('/billing/done', (c) => {
  const key = c.req.query('key') ?? '';
  return c.html(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${c.env.APP_NAME}</title>
<body style="background:#0a0b0f;color:#eef1f6;font:16px/1.6 -apple-system,system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 20px">
<h1>You're all set</h1><p>Go back to ${c.env.APP_NAME}. It unlocks by itself within a few seconds.</p>
${LICENSE_KEY.test(key) ? `<p>Your license key, if the app asks for it:<br><code style="font-size:20px">${key}</code></p>` : ''}</body>`);
});

// Body: { token }. Only a computer that is active on the license gets its portal link.
app.post('/api/billing/portal', async (c) => {
  const body = await c.req.json<any>().catch(() => null);
  const claims = body?.token ? await verifyToken(c.env, String(body.token)) : null;
  if (!hasValidClaims(claims)) return c.json({ ok: false, error: 'invalid_token' }, 401);
  const license = await c.env.DB
    .prepare('SELECT l.polar_customer_id FROM licenses l JOIN activations a ON a.license_key = l.key WHERE l.key = ? AND a.device_id = ? AND a.revoked_at IS NULL')
    .bind(claims.k, claims.d)
    .first<any>();
  if (!license?.polar_customer_id) return c.json({ ok: false, error: 'no_subscription' }, 404);
  const session = await polar(c.env, '/v1/customer-sessions/', { customer_id: license.polar_customer_id });
  return c.json({ ok: true, url: session.customer_portal_url });
});

// Standard Webhooks: HMAC-SHA256 over "id.timestamp.body", keyed with the base64 part of the whsec_ secret.
async function isFromPolar(env: Env, headers: Headers, raw: string): Promise<boolean> {
  const id = headers.get('webhook-id'), timestamp = headers.get('webhook-timestamp'), signatures = headers.get('webhook-signature');
  if (!env.POLAR_WEBHOOK_SECRET || !id || !timestamp || !signatures) return false;
  // Stops a captured request being replayed later.
  if (!(Math.abs(Date.now() / 1000 - Number(timestamp)) <= 300)) return false;
  try {
    const secret = b64urlToBytes(env.POLAR_WEBHOOK_SECRET.replace(/^whsec_/, ''));
    const key = await crypto.subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const signed = new TextEncoder().encode(`${id}.${timestamp}.${raw}`);
    for (const signature of signatures.split(' ')) {
      const [version, value] = signature.split(',');
      // The header is a list (key rotation), so one unreadable entry must not hide a good one after it.
      try {
        if (version === 'v1' && value && await crypto.subtle.verify('HMAC', key, b64urlToBytes(value) as BufferSource, signed)) return true;
      } catch { /* not base64: no match */ }
    }
  } catch { /* a malformed secret is a refusal */ }
  return false;
}

app.post('/webhooks/polar', async (c) => {
  const raw = await c.req.text();
  if (!(await isFromPolar(c.env, c.req.raw.headers, raw))) return c.text('bad signature', 403);
  const event = JSON.parse(raw);
  const sub = event.data;
  // Every subscription.* event carries the whole subscription, so they are all handled the same way.
  if (!String(event.type).startsWith('subscription.') || sub?.product_id !== c.env.POLAR_PRODUCT_ID) return c.json({ ok: true, ignored: true }, 202);

  const at = Date.parse(event.timestamp);
  const entitled = sub.status === 'trialing' || sub.status === 'active';
  // During a trial the current period is the trial. A failed card gets the same few days to be fixed;
  // anything else (canceled, unpaid, paused, never paid) ends access now.
  const expiresAt = entitled ? Date.parse(sub.current_period_end) + RENEWAL_SLACK_MS
    : sub.status === 'past_due' ? Date.parse(sub.current_period_start) + RENEWAL_SLACK_MS
    : at;
  const key = LICENSE_KEY.test(sub.metadata?.license_key) ? sub.metadata.license_key : newLicenseKey();
  // On the per-seat price a seat is a computer, and the customer can change the number later in Polar's portal.
  // This overwrites a device limit set by hand in the admin panel: what is paid for decides.
  const seats = Number.isInteger(sub.seats) && sub.seats > 0 ? sub.seats : 1;
  await c.env.DB.batch([
    c.env.DB
      .prepare('UPDATE licenses SET email = ?, expires_at = ?, polar_event_at = ?, max_devices = ?, plan = ? WHERE polar_subscription_id = ? AND polar_event_at <= ?')
      .bind(sub.customer.email, expiresAt, at, seats, planFor(seats), sub.id, at),
    // First sight of the subscription. Ignored once its row exists, and never made for one that isn't paid or on trial.
    ...(entitled ? [c.env.DB
      .prepare('INSERT OR IGNORE INTO licenses (key, email, plan, max_devices, expires_at, polar_subscription_id, polar_customer_id, polar_event_at, account_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(key, sub.customer.email, planFor(seats), seats, expiresAt, sub.id, sub.customer_id, at, sub.metadata?.account_email ?? null)] : []),
    // Seats were reduced below the computers in use: the most recently used ones keep working. It reads the
    // limit the license ended up with, so a late retry of an older event can't remove computers either.
    c.env.DB
      .prepare(`UPDATE activations SET revoked_at = ?1 WHERE revoked_at IS NULL
        AND license_key = (SELECT key FROM licenses WHERE polar_subscription_id = ?2)
        AND device_id NOT IN (SELECT device_id FROM activations
          WHERE revoked_at IS NULL AND license_key = (SELECT key FROM licenses WHERE polar_subscription_id = ?2)
          ORDER BY last_seen_at DESC LIMIT COALESCE((SELECT max_devices FROM licenses WHERE polar_subscription_id = ?2), 0))`)
      .bind(Date.now(), sub.id),
  ]);
  return c.json({ ok: true }, 202);
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

// The license for a website account, or null. `error` is why the app would refuse it, if it would.
// A subscription only counts if that account started it: accounts don't prove they own their email, so
// matching a subscription bought in the app by email alone would hand its key and billing page to a stranger.
app.get('/admin/license', async (c) => {
  const bad = requireAdmin(c); if (bad) return bad;
  const { results } = await c.env.DB
    .prepare(`SELECT l.*, p.ends_at AS plan_ends_at, (SELECT COUNT(*) FROM activations a WHERE a.license_key = l.key AND a.revoked_at IS NULL) AS active_devices
      FROM licenses l LEFT JOIN plan_ends p ON p.plan = l.plan
      WHERE (l.polar_subscription_id IS NULL AND lower(l.email) = ?1) OR lower(l.account_email) = ?1 ORDER BY l.created_at DESC`)
    .bind(String(c.req.query('email') ?? '').trim().toLowerCase())
    .all<any>();
  // A working license first (a subscriber can still have an older free one), otherwise the newest.
  const license = results.find((l) => !licenseError(l)) ?? results[0] ?? null;
  return c.json({ ok: true, license: license && { ...license, error: licenseError(license) } });
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

const BETA_MAX_DEVICES = 1;

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
  const key = c.req.query('key') ?? null;
  const since = Date.now() - 30 * 24 * 3600_000;
  // The same three queries serve the whole app and one license: NULL matches everything.
  const [errors, events, recent] = await Promise.all([
    c.env.DB.prepare('SELECT id, license_key, kind, message, stack, app_version, os, created_at FROM telemetry_errors WHERE (?1 IS NULL OR license_key = ?1) ORDER BY created_at DESC LIMIT 50').bind(key).all(),
    c.env.DB.prepare('SELECT name, COUNT(*) AS n, COUNT(DISTINCT license_key) AS users FROM telemetry_events WHERE (?1 IS NULL OR license_key = ?1) AND created_at > ?2 GROUP BY name ORDER BY n DESC LIMIT 30').bind(key, since).all(),
    c.env.DB.prepare('SELECT id, license_key, name, app_version, os, created_at FROM telemetry_events WHERE (?1 IS NULL OR license_key = ?1) ORDER BY created_at DESC LIMIT 30').bind(key).all(),
  ]);
  return c.json({ ok: true, errors: errors.results, events: events.results, recent: recent.results });
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
