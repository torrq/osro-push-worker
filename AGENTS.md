# AGENTS.md — Context for LLM-assisted development

## What this is

A Cloudflare Worker + D1 backend serving both [**osro-quests-hr**](https://github.com/torrq/osro-quests-hr) (`app="hr"`) and [**osro-quests-mr**](https://github.com/torrq/osro-quests-mr) (`app="mr"`). It handles:
1. **Authentication (`src/auth.js`)**: 16-character Sync Codes (Crockford-style alphabet without `O`, `I`, `L`; SHA-256 hashed in D1), optional Google ID token verification (RS256 via cached Google JWKS), and 30-day HMAC-SHA256 JWT sessions.
2. **Cloud Sync (`src/sync.js`)**: Per-key timestamped storage in D1 (`kv` table partitioned by `(account_id, app, key)`) with 30-day tombstone pruning and size limits (256 KB per key, 2 MB total body).
3. **Web Push & Multi-Device Fan-out (`src/index.js`)**: Delayed timer scheduling via Upstash QStash (`/schedule`, `/cancel`) and webhook delivery (`/webhook`) that fans out notifications to all devices registered to an `account_id` in D1 (automatically pruning `404`/`410` dead subscriptions).

**Deployed at:** `https://osro-push-worker.osro-push-worker.workers.dev`  
**Frontend repos:** `torrq/osro-quests-hr` and `torrq/osro-quests-mr` (GitHub Pages)

---

## File map

```
src/
  index.js            — router, CORS, JWT auth middleware, /schedule, /cancel, /webhook
  auth.js             — JWT sign/verify (HS256), Sync Code generation/hashing, Google JWKS RS256 verification
  sync.js             — D1 handlers for /auth/*, /sync (GET/PUT/DELETE), and /devices (PUT/DELETE)
schema.sql            — D1 SQLite schema (accounts, kv, devices + indexes)
wrangler.jsonc        — Worker config, plain vars, nodejs_compat flag, D1 binding (DB)
package.json          — scripts: deploy, dev, test
test/index.spec.js    — vitest test file
```

---

## Key architectural rules

1. **Multi-app partitioning (`app = 'hr' | 'mr'`)**:
   - `kv` rows are keyed by `(account_id, app, key)`. A single Sync Code or Google account can sync both HR and MR without key collisions.
   - `devices` are shared at the `account_id` level so any timer scheduled on HR or MR notifies all linked devices for that user.
2. **CORS headers on all browser-facing responses**:
   - `getCorsHeaders(request)` allows `https://torrq.github.io`, `http://localhost:*`, and `http://127.0.0.1:*`.
   - Always pass `corsHeaders` to `jsonResponse()` (including error paths) so the browser receives the real HTTP status instead of a CORS failure.
3. **QStash delay & region**:
   - `Upstash-Delay` is in **seconds** (`${delay}s`).
   - `QSTASH_URL`, `QSTASH_MESSAGES_URL`, and `QSTASH_TOKEN` must all belong to the same QStash region.
4. **Stale push subscription cleanup**:
   - In `/webhook`, when fanning out across `devices`, use `Promise.allSettled` and delete any device row whose push endpoint returns `404` or `410`. Return `200` after fan-out so QStash does not retry delivered notifications.
5. **Runtime requirements**:
   - `nodejs_compat` is required in `wrangler.jsonc` for `web-push`.
   - Auth and hashing in `src/auth.js` use the standard Web Crypto API (`crypto.subtle`).
