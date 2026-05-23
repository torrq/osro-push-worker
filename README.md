# osro-push-worker

Cloudflare Worker that acts as the secure backend for OSRO Quests (HR) push notifications. It proxies requests from the GitHub Pages frontend to Upstash QStash for delayed scheduling, and receives QStash callbacks to deliver push notifications via the Web Push protocol.

## Architecture

```
GitHub Pages (osro-quests-hr)
  └─ POST /schedule  ──►  Cloudflare Worker  ──►  Upstash QStash (delayed)
  └─ POST /cancel    ──►  Cloudflare Worker  ──►  Upstash QStash (delete)

Upstash QStash (after delay)
  └─ POST /webhook   ──►  Cloudflare Worker  ──►  Mozilla Push Service  ──►  sw.js
```

## Routes

| Method | Path | Caller | Purpose |
|--------|------|--------|---------|
| `POST` | `/schedule` | Frontend | Queue a delayed push. Body: `{ subscription, delay, payload }`. `delay` is **seconds**. Returns `{ messageId }`. |
| `POST` | `/cancel` | Frontend | Delete a pending QStash message. Body: `{ messageId }`. |
| `POST` | `/webhook` | QStash | Deliver push notification. Validates `Authorization: Bearer INTERNAL_SECRET`, calls `web-push`. |
| `OPTIONS` | `*` | Browser | CORS preflight. |

`payload` passed to `/schedule` must include `{ title, body, url }` — `url` is forwarded to `sw.js` and used as the click target.

## Environment variables

Set secrets with `wrangler secret put <NAME>`:

| Variable | In `wrangler.jsonc` (plain var) | Description |
|---|---|---|
| `VAPID_SUBJECT` | ✅ | `mailto:` address for VAPID |
| `QSTASH_URL` | ✅ | `https://qstash-us-east-1.upstash.io/v2/publish/` |
| `QSTASH_MESSAGES_URL` | ✅ | `https://qstash-us-east-1.upstash.io/v2/messages/` |
| `QSTASH_TOKEN` | secret | Upstash QStash API token |
| `VAPID_PUBLIC_KEY` | secret | VAPID public key |
| `VAPID_PRIVATE_KEY` | secret | VAPID private key |
| `INTERNAL_SECRET` | secret | Shared secret for QStash → /webhook auth |

Local development: copy `.dev.vars.example` to `.dev.vars` and fill in values. `.dev.vars` is gitignored.

## QStash region

The `QSTASH_URL` and `QSTASH_MESSAGES_URL` in `wrangler.jsonc` must match the region of your `QSTASH_TOKEN` (e.g. `us-east-1`). A token/URL region mismatch produces `401 Unauthorized` from QStash.

## Setup

```bash
npm install
wrangler secret put QSTASH_TOKEN
wrangler secret put VAPID_PUBLIC_KEY
wrangler secret put VAPID_PRIVATE_KEY
wrangler secret put INTERNAL_SECRET
```

**Generate VAPID keys** (one-time):
```bash
npx web-push generate-vapid-keys
```
The public key also needs to go into `main.js` in the `osro-quests-hr` repo as the `applicationServerKey` passed to `pushManager.subscribe()`.

## Deploy

```bash
npm run deploy
# or
wrangler deploy
```

## Local dev

```bash
npm run dev
# Worker available at http://localhost:8787
```

Note: QStash cannot call `localhost` for the `/webhook` route during local dev. To test the full flow, use a tunnel (e.g. `cloudflared tunnel`) or deploy to a preview environment.

## Dependencies

- [`web-push`](https://github.com/web-push-libs/web-push) — Web Push protocol implementation
- `nodejs_compat` compatibility flag required in `wrangler.jsonc` for `web-push` to work in the Workers runtime
