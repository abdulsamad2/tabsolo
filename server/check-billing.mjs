// Self-check for the Polar webhook: signature, license creation, late retries, cancellation. It changes data, so it only runs against a local server:
//   npx wrangler dev --local --port 8799 --var ADMIN_TOKEN:local-test-token --var POLAR_PRODUCT_ID:prod-test --var POLAR_WEBHOOK_SECRET:whsec_bG9jYWwtdGVzdC13ZWJob29rLXNlY3JldA==
//   node check-billing.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const base = process.env.API_BASE ?? 'http://localhost:8799';
assert.equal(new URL(base).hostname, 'localhost', 'refusing to run against a non-local server');
const secret = Buffer.from('bG9jYWwtdGVzdC13ZWJob29rLXNlY3JldA==', 'base64');
const day = 86_400_000;

let n = 0;
async function send(type, sub, { at = Date.now(), sentAt = Date.now(), key = secret } = {}) {
  const body = JSON.stringify({ type, timestamp: new Date(at).toISOString(), data: sub });
  const id = `msg_${Date.now()}_${n++}`, ts = String(Math.floor(sentAt / 1000));
  const signature = crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  return fetch(`${base}/webhooks/polar`, { method: 'POST', body, headers: { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,other v1,${signature}` } });
}
const licenseFor = async (subId) => (await (await fetch(`${base}/admin/licenses`, { headers: { authorization: 'Bearer local-test-token' } })).json())
  .licenses.find((l) => l.polar_subscription_id === subId);

const run = Date.now().toString(36).toUpperCase().replace(/[01IO]/g, 'X').padStart(8, 'A').slice(-8);
const licenseKey = `TS-${run.slice(0, 4)}-${run.slice(4)}-TEST`;
const periodEnd = Date.now() + 7 * day;
const sub = (extra = {}) => ({
  id: `sub-${run}`, status: 'trialing', product_id: 'prod-test', customer_id: 'cus-1', customer: { email: 'buyer@example.com' },
  current_period_start: new Date(periodEnd - 7 * day).toISOString(), current_period_end: new Date(periodEnd).toISOString(),
  metadata: { license_key: licenseKey }, ...extra,
});
const t0 = Date.now() - 10_000;

assert.equal((await send('subscription.created', sub(), { key: Buffer.from('wrong') })).status, 403, 'wrong secret');
assert.equal((await send('subscription.created', sub(), { sentAt: Date.now() - 3600_000 })).status, 403, 'replayed an hour later');
assert.equal(await licenseFor(sub().id), undefined);

assert.equal((await send('subscription.created', sub({ status: 'incomplete' }), { at: t0 })).status, 202);
assert.equal(await licenseFor(sub().id), undefined, 'an unpaid checkout gets no license');
await send('subscription.created', sub({ id: `other-${run}`, product_id: 'another-product' }), { at: t0 });
assert.equal(await licenseFor(`other-${run}`), undefined, 'another product gets no license');

await send('subscription.created', sub(), { at: t0 + 1000 });
let license = await licenseFor(sub().id);
assert.equal(license.key, licenseKey, 'the key the app was given at checkout');
assert.deepEqual([license.plan, license.email, license.status, license.max_devices, license.polar_customer_id], ['solo', 'buyer@example.com', 'active', 1, 'cus-1']);
assert.equal(license.expires_at, periodEnd + 3 * day, 'the trial lasts to the period end plus slack');

// The trial converts: a new period, one month on.
await send('subscription.updated', sub({ status: 'active', current_period_end: new Date(periodEnd + 30 * day).toISOString() }), { at: t0 + 2000 });
assert.equal((await licenseFor(sub().id)).expires_at, periodEnd + 33 * day);

await send('subscription.updated', sub({ status: 'past_due', current_period_start: new Date(periodEnd).toISOString() }), { at: t0 + 3000 });
assert.equal((await licenseFor(sub().id)).expires_at, periodEnd + 3 * day, 'a failed card keeps a few days');

await send('subscription.revoked', sub({ status: 'canceled' }), { at: t0 + 5000 });
assert.equal((await licenseFor(sub().id)).expires_at, t0 + 5000, 'revoked ends access');
await send('subscription.active', sub({ status: 'active' }), { at: t0 + 4000 });
license = await licenseFor(sub().id);
assert.equal(license.expires_at, t0 + 5000, 'a late retry of an older event must not bring access back');
assert.equal(license.key, licenseKey);

// The website: the license belongs to the account that started the checkout, not the email typed at Polar.
const admin = (path, body) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer local-test-token' }, body: body && JSON.stringify(body) });
const account = `account-${run.toLowerCase()}@example.com`;
const accountLicense = async () => (await (await admin(`/admin/license?email=${encodeURIComponent(account.toUpperCase())}`)).json()).license;
assert.equal(await accountLicense(), null, 'no license before subscribing');
await admin('/admin/beta-license', { email: account });
await admin('/admin/plan-end', { plan: 'beta', endsAt: Date.now() - 1000 });
assert.equal((await accountLicense()).error, 'plan_ended', 'an ended free license is shown, with the reason');
const siteSub = { ...sub(), id: `site-${run}`, metadata: { account_email: account } };
await send('subscription.active', { ...siteSub, status: 'active' }, { at: Date.now() });
license = await accountLicense();
assert.deepEqual([license.plan, license.error, license.polar_subscription_id, license.active_devices, license.email], ['solo', null, siteSub.id, 0, 'buyer@example.com'], 'the working subscription wins over the ended free license');
assert.equal((await (await admin('/admin/license?email=buyer@example.com')).json()).license, null, 'a subscription bought in the app is not handed to an account with the same email');
await admin('/admin/plan-end', { plan: 'beta', endsAt: null });

assert.equal((await fetch(`${base}/admin/license?email=${account}`)).status, 403, 'admin only');
assert.equal((await admin('/admin/checkout', { email: account, successUrl: 'javascript:alert(1)' })).status, 400);
assert.equal((await admin('/admin/checkout', { email: account, successUrl: 'https://www.tabsolo.com/account' })).status, 503, 'no Polar token locally');
assert.equal((await admin('/admin/portal', { key: 'TS-NOPE-NOPE-NOPE' })).status, 404);
assert.equal((await fetch(`${base}/api/billing/checkout`, { method: 'POST' })).status, 503, 'no Polar token locally');
assert.equal((await fetch(`${base}/api/billing/portal`, { method: 'POST', body: '{"token":"x.y"}' })).status, 401);
const page = await (await fetch(`${base}/billing/done?key=${encodeURIComponent('<script>alert(1)</script>')}`)).text();
assert.ok(!page.includes('<script>'), 'the key in the URL is never echoed unchecked');
assert.ok((await (await fetch(`${base}/billing/done?key=${licenseKey}`)).text()).includes(licenseKey));
console.log('billing checks passed');
