# AGENTS.md — Context for LLM-assisted development

## What this is

A Cloudflare Worker that acts as a secure proxy between the OSRO Quests (HR) GitHub Pages frontend and Upstash QStash. Its sole job is scheduling and delivering Web Push notifications for the Lab timer system. It holds secrets the frontend cannot (VAPID keys, QStash token) and validates inbound webhook calls from QStash before forwarding to the Mozilla Push Service.

**Deployed at:** `https://osro-push-worker.osro-push-worker.workers.dev`  
**Frontend repo:** `torrq/osro-quests-hr` (GitHub Pages)

---

## File map

```
src/index.js          — entire worker logic (three routes + CORS)
wrangler.jsonc        — worker config, plain env vars, compatibility flags
package.json          — scripts: deploy, dev, test
test/index.spec.js    — vitest test stub (boilerplate, not updated for actual routes)
.dev.vars             — local secrets (gitignored; copy from .dev.vars.example)
```

---

## Routes

### `POST /schedule`
Called by the frontend. Forwards a delayed push job to QStash.

Request body:
```json
{ "subscription": { ... }, "delay": 86400, "payload": { "title": "...", "body": "...", "url": "https://..." } }
```
- `delay` is in **seconds**. Passing milliseconds silently schedules 1000+ days ahead.
- Forwards to `env.QSTASH_URL + webhookUrl` with `Upstash-Delay: ${delay}s` and `Upstash-Forward-Authorization: Bearer INTERNAL_SECRET`.
- Returns `{ messageId }` (QStash returns either `messageId` or `id` depending on version — code handles both).
- Includes `corsHeaders` on success response. **Also add them to error responses** if you add new error paths, or CORS masking will hide the real status from the browser.

### `POST /cancel`
Called by the frontend to cancel a pending QStash message before it fires.

Request body: `{ "messageId": "..." }`  
Calls `DELETE env.QSTASH_MESSAGES_URL + messageId`.

### `POST /webhook`
Called by QStash after the delay expires. **Not called by the frontend.**

- Validates `Authorization: Bearer INTERNAL_SECRET`. Returns 401 if missing or wrong.
- Calls `webpush.sendNotification(subscription, JSON.stringify(payload))`.
- On failure, logs `statusCode`, `body`, `endpoint`, and full error — check Cloudflare logs for the real failure reason (common: `410 Gone` = expired subscription, `401` = VAPID mismatch).
- Returns 5xx on failure; QStash will **retry** on 5xx, so transient errors get another attempt.

### `OPTIONS *`
Returns CORS preflight headers. Always present for browser compatibility.

---

## Environment variables

| Variable | How set | Notes |
|---|---|---|
| `VAPID_SUBJECT` | `wrangler.jsonc` vars | `mailto:` address |
| `QSTASH_URL` | `wrangler.jsonc` vars | Full regional publish URL including trailing `/` |
| `QSTASH_MESSAGES_URL` | `wrangler.jsonc` vars | Full regional messages URL including trailing `/` |
| `QSTASH_TOKEN` | `wrangler secret` | Must match the region in the URLs above |
| `VAPID_PUBLIC_KEY` | `wrangler secret` | Must match the key used by frontend's `pushManager.subscribe()` |
| `VAPID_PRIVATE_KEY` | `wrangler secret` | Keep private; never commit |
| `INTERNAL_SECRET` | `wrangler secret` | Arbitrary string; used to authenticate QStash → /webhook |

**QStash region rule:** `QSTASH_URL`, `QSTASH_MESSAGES_URL`, and `QSTASH_TOKEN` must all be from the same region. Mismatched region = 401 from QStash on every `/schedule` call.

---

## Key constraints

- **`nodejs_compat` flag is required** in `wrangler.jsonc`. The `web-push` package uses Node.js crypto APIs that aren't available in the baseline Workers runtime.
- **`Upstash-Delay` is in seconds** — this is easy to get wrong. The frontend's `osroScheduleCloudPush` passes `delayInSeconds`; verify any change to that call path preserves the unit conversion (`Math.ceil(remainingMs / 1000)`).
- **CORS headers must be on error responses too.** The current `/schedule` error path returns them; if you add new error returns in any route called by the browser, include `...corsHeaders` or the browser will see a CORS error instead of the real status.
- **`/webhook` is only called by QStash**, never the browser directly. CORS headers are not needed there.
- **QStash retries on 5xx.** The `/webhook` handler should only return 5xx for genuinely transient failures. A 410 Gone from the push service means the subscription is dead — returning 200 (after logging) would stop retries; returning 5xx will cause repeated retries that will all fail the same way.

---

## Common failure modes

| Symptom | Likely cause |
|---|---|
| `/schedule` returns 401 | QStash token doesn't match regional URL |
| `/schedule` returns 401 masked as CORS error | Error response missing `corsHeaders` |
| Push fires 1000 days later | `delay` passed in milliseconds instead of seconds |
| `/webhook` push fails with 401 | VAPID keys don't match what the browser subscribed with |
| `/webhook` push fails with 410 Gone | Subscription expired; user needs to re-subscribe |
| Notification fires after timer was stopped | Frontend didn't call `/cancel` with the saved `messageId` |
| Worker fails to import `web-push` | `nodejs_compat` flag missing from `wrangler.jsonc` |

---

## Deploying changes

```bash
npm run deploy        # deploys src/index.js to Cloudflare
wrangler tail         # stream live logs from deployed worker
```

Secrets are set once with `wrangler secret put <NAME>` and persist across deploys. Plain vars in `wrangler.jsonc` are redeployed with the worker each time.

---

## Relationship to osro-quests-hr

The frontend calls this worker from `osroScheduleCloudPush` and `osroCancelCloudPush` in `js/main.js`. The worker URL is hardcoded there as `CLOUDFLARE_WORKER_URL`. The VAPID public key used in `pushManager.subscribe()` must match `VAPID_PUBLIC_KEY` set here — if they diverge, all `/webhook` deliveries will fail with 401.

The `payload.url` field passed through `/schedule` ends up in `sw.js`'s notification `data` object and is used as the `notificationclick` navigation target. Format: `https://torrq.github.io/osro-quests-hr/?tab=lab-*`.
