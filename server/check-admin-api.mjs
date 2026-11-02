// Self-check for the admin endpoints the website's panel uses. It changes data, so it only runs against a local server:
//   npx wrangler dev --local --port 8799 --var ADMIN_TOKEN:local-test-token
//   node check-admin-api.mjs
import assert from 'node:assert/strict';

const base = process.env.API_BASE ?? 'http://localhost:8799';
const token = process.env.ADMIN_TOKEN ?? 'local-test-token';
assert.equal(new URL(base).hostname, 'localhost', 'refusing to run against a non-local server');

const call = (path, body, auth = token) => fetch(base + path, {
  method: body ? 'POST' : 'GET',
  headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
  body: body && JSON.stringify(body),
});
const update = (body) => call('/admin/license/update', body);

const email = `check-${Date.now()}@example.com`;
const { license } = await (await call('/admin/beta-license', { email })).json();
const current = async () => (await (await call('/admin/licenses')).json()).licenses.find((l) => l.key === license.key);

for (const [path, body] of [['/admin/license/update', { key: license.key, status: 'active' }], ['/admin/telemetry'], ['/admin/plan-ends']]) {
  assert.equal((await call(path, body, 'wrong')).status, 403, `${path} must reject a wrong token`);
}
for (const bad of [{ status: 'active' }, { key: license.key }, { key: license.key, status: 'expired' }, { key: license.key, max_devices: 0 }, { key: license.key, max_devices: 101 }, { key: license.key, max_devices: 1.5 }]) {
  assert.equal((await update(bad)).status, 400, JSON.stringify(bad));
}
assert.equal((await update({ key: 'TS-NOPE', status: 'active' })).status, 404);

assert.equal((await update({ key: license.key, max_devices: 5 })).status, 200);
assert.equal((await current()).max_devices, 5);
assert.equal((await current()).status, 'active', 'changing the limit must not touch the status');

assert.equal((await call('/admin/revoke', { key: license.key })).status, 200);
assert.equal((await current()).status, 'revoked');
assert.equal((await update({ key: license.key, status: 'active' })).status, 200);
assert.equal((await current()).status, 'active');
assert.equal((await current()).max_devices, 5, 'restoring must not touch the limit');

const telemetry = await (await call('/admin/telemetry')).json();
assert.ok(Array.isArray(telemetry.errors) && Array.isArray(telemetry.events));
assert.ok(Array.isArray((await (await call('/admin/plan-ends')).json()).planEnds));
console.log('admin API checks passed');
