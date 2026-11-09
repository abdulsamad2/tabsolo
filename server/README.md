# TabSolo API (Cloudflare Workers + D1)

License + telemetry backend. Free up to thousands of users.

## One-time deploy

```bash
cd server
npm install
npx wrangler login                                # authenticate once
npx wrangler d1 create tabsolo                   # copy the database_id into wrangler.toml
npm run db:migrate:prod                           # creates the four tables remotely
npx wrangler secret put ADMIN_TOKEN               # paste a long random string
npx wrangler secret put TOKEN_SIGNING_JWK         # Ed25519 private key as JWK; put its public x in src/license/license.js
npm run deploy                                    # live at https://tabsolo-api.<account>.workers.dev
```

## Issue a license

```bash
curl -X POST https://tabsolo-api.<account>.workers.dev/admin/license \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"key":"TF-XXXX-YYYY-ZZZZ","email":"customer@example.com","plan":"solo"}'
```

Plans: `solo` (1 device), `pro` (3 devices), `team` (set `max_devices` yourself).

## Subscriptions and free trials (Polar)

Polar takes the payments and runs the trial; each subscription shows up here as a license that expires when the
subscription does. The product is priced per seat and a seat is a computer: the license's device limit follows the
seats the customer pays for (plan `solo` for one, `team` for more), including when they change it in Polar's portal. In the app, "Start free trial" opens the Polar checkout and unlocks when it is paid.

One-time setup, first in the Polar sandbox (https://sandbox.polar.sh), then again for live:

1. Create a subscription product. Set its price and its **trial period** on the product.
2. Settings → Subscription → turn on **Prevent trial abuse**, so one customer gets one trial.
3. Put the product's ID in `POLAR_PRODUCT_ID` in `wrangler.toml` (and `POLAR_API` to `https://api.polar.sh` for live).
4. Create an organization access token with `checkouts:write` and `customer_sessions:write`: `npx wrangler secret put POLAR_ACCESS_TOKEN`
5. Add a webhook endpoint for `https://tabsolo-api.<account>.workers.dev/webhooks/polar` with the `subscription.created`
   and `subscription.updated` events, then: `npx wrangler secret put POLAR_WEBHOOK_SECRET` (the `whsec_…` value).
6. `npm run db:migrate:prod && npm run deploy`

The website's account page does the same through `/admin/checkout`, `/admin/license` and `/admin/portal`, so
deploy this server (step 6) before the website. A subscription started there shows its key on that account's page.

A customer who subscribed in the app and lost the key: find it by email in the admin license list.

## Admin dashboard

Open `https://tabsolo-api.<account>.workers.dev/admin/dashboard` in a browser with the `Authorization: Bearer <ADMIN_TOKEN>` header set (use the ModHeader extension, or curl).

## Revoke

```bash
# Revoke the whole license (burns all devices)
curl -X POST .../admin/revoke -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"key":"TF-XXXX-YYYY-ZZZZ"}'

# Just one device slot (frees it up for the user to re-activate elsewhere)
curl -X POST .../admin/revoke -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"key":"TF-XXXX-YYYY-ZZZZ","deviceId":"<the-device-id>"}'
```

## Local dev

```bash
npm run db:migrate:local
npm run dev    # http://127.0.0.1:8787
```
