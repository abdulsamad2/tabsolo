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
npx wrangler secret put HMAC_SECRET               # paste another long random string
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
