# osro-push-worker

Cloudflare Worker backend for [**OSRO Quests (Highrate)**](https://github.com/torrq/osro-quests-hr) and [**OSRO Quests (Midrate)**](https://github.com/torrq/osro-quests-mr).

It provides:
1. **Cross-Device Cloud Sync (Cloudflare D1)**: Synchronizes user settings, custom themes, Autoloot v2 sets, item values, bookmarks, Lab timers, and Deposit/Unlock tracker progress across devices via 16-character Sync Codes (with QR code support) or Google Sign-In.
2. **Delayed Push Notifications (Upstash QStash + Web Push)**: Schedules delayed timer notifications and fans out Web Push notifications to **all** linked devices for an account (or to a single subscription for unlinked users).

---

## Architecture

```
GitHub Pages Frontends (osro-quests-hr / osro-quests-mr)
  ├─ POST /auth/*        ──►  Cloudflare Worker  ──►  Cloudflare D1 (accounts)
  ├─ GET/PUT/DEL /sync   ──►  Cloudflare Worker  ──►  Cloudflare D1 (kv per app: 'hr' | 'mr')
  ├─ PUT/DEL /devices    ──►  Cloudflare Worker  ──►  Cloudflare D1 (devices)
  ├─ POST /schedule      ──►  Cloudflare Worker  ──►  Upstash QStash (delayed)
  └─ POST /cancel        ──►  Cloudflare Worker  ──►  Upstash QStash (delete)

Upstash QStash (when timer expires)
  └─ POST /webhook       ──►  Cloudflare Worker  ──►  D1 devices fan-out  ──►  Web Push  ──►  sw.js
```

---

## Routes

### Authentication (`src/auth.js` & `src/sync.js`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/auth/code/new` | Public | Generates a new 16-char Sync Code (`XXXX-XXXX-XXXX-XXXX`), stores its SHA-256 hash in `accounts`, and returns `{ code, token, accountId }`. |
| `POST` | `/auth/code` | Public | Authenticates an existing Sync Code (normalizing `O`→`0` and `I`/`L`→`1`) and returns a 30-day HMAC-SHA256 JWT `{ token, accountId, email }`. |
| `POST` | `/auth/google` | Public | Verifies a Google ID token against Google's public JWKS and signs in or creates an account. |
| `POST` | `/auth/link-google` | Bearer JWT | Links a Google account (`google_sub`, `email`) to the currently authenticated Sync Code profile. |

### Cloud Sync & Device Registry (`src/sync.js`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/sync?app=hr\|mr` | Bearer JWT | Prunes tombstones older than 30 days and returns all synced keys `{ keys: { [key]: { value, updatedAt, deleted } } }` for the specified app (`hr` or `mr`). |
| `PUT` | `/sync` | Bearer JWT | Batch-upserts changed keys `{ app, changes }` when `incoming.updatedAt >= existing.updatedAt` (256 KB per key, 2 MB max payload) and returns the merged state. |
| `DELETE` | `/sync?app=hr\|mr` | Bearer JWT | Deletes cloud data for the specified `app` (or entire account if `app` is omitted). |
| `PUT` | `/devices` | Bearer JWT | Registers or updates a device's Web Push subscription `{ deviceId, subscription, label }`. |
| `DELETE` | `/devices/:deviceId` | Bearer JWT | Removes a registered device push subscription. |

### Timer Push Scheduling (`src/index.js`)

| Method | Path | Caller | Description |
|--------|------|--------|-------------|
| `POST` | `/schedule` | Frontend | Queues a delayed push via QStash. Body: `{ subscription, deviceId, delay, payload }` (`delay` in **seconds**). If authenticated, upserts the device in D1 and attaches `accountId`. Returns `{ messageId }`. |
| `POST` | `/cancel` | Frontend | Cancels a pending QStash message. Body: `{ messageId }`. |
| `POST` | `/webhook` | QStash | Validates `Authorization: Bearer INTERNAL_SECRET`. If `accountId` is present, fans out the push notification to all registered devices in D1 (and prunes `404`/`410` expired subscriptions); otherwise sends to `subscription`. |
| `OPTIONS` | `*` | Browser | CORS preflight for `https://torrq.github.io` and `localhost`. |

---

## Cloudflare D1 Schema (`schema.sql`)

- **`accounts`**: `(id PRIMARY KEY, google_sub UNIQUE, code_hash UNIQUE, email, created_at)`
- **`kv`**: `(account_id, app, key, value, updated_at, deleted, PRIMARY KEY (account_id, app, key))`
- **`devices`**: `(account_id, device_id, subscription, label, last_seen, PRIMARY KEY (account_id, device_id))`

Initialize or apply schema:
```bash
wrangler d1 execute osro-sync --remote --file=schema.sql
# Local dev:
wrangler d1 execute osro-sync --local --file=schema.sql
```

---

## Environment Variables & Bindings

Configured in `wrangler.jsonc` and via `wrangler secret put <NAME>`:

| Name | Type | Description |
|------|------|-------------|
| `DB` | D1 Binding | Cloudflare D1 database (`osro-sync`) |
| `VAPID_SUBJECT` | `wrangler.jsonc` var | `mailto:` contact address for Web Push VAPID |
| `QSTASH_URL` | `wrangler.jsonc` var | Regional QStash publish endpoint (e.g. `https://qstash-us-east-1.upstash.io/v2/publish/`) |
| `QSTASH_MESSAGES_URL` | `wrangler.jsonc` var | Regional QStash messages endpoint (e.g. `https://qstash-us-east-1.upstash.io/v2/messages/`) |
| `SESSION_SECRET` | Secret | HMAC-SHA256 secret used to sign and verify 30-day session JWTs |
| `QSTASH_TOKEN` | Secret | Upstash QStash API token (must match region of `QSTASH_URL`) |
| `VAPID_PUBLIC_KEY` | Secret | VAPID public key (must match `applicationServerKey` in frontends) |
| `VAPID_PRIVATE_KEY` | Secret | VAPID private key |
| `INTERNAL_SECRET` | Secret | Shared bearer secret authenticating QStash → `/webhook` |
| `GOOGLE_CLIENT_ID` | Secret / var | *(Optional)* Google OAuth Web Client ID for Google Sign-In verification |

---

## Setup & Deployment

```bash
npm install

# Configure secrets (one-time)
wrangler secret put SESSION_SECRET
wrangler secret put QSTASH_TOKEN
wrangler secret put VAPID_PUBLIC_KEY
wrangler secret put VAPID_PRIVATE_KEY
wrangler secret put INTERNAL_SECRET

# Deploy to Cloudflare Workers
npm run deploy
```

### Local Development

```bash
npm run dev
# Worker available at http://localhost:8787
```
