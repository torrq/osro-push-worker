// src/sync.js — Cloudflare D1 persistence handlers for sync & device push subscriptions
import {
  createSessionToken,
  generateSyncCode,
  hashSyncCode,
  verifyGoogleIdToken,
} from './auth.js';

const MAX_KEY_SIZE_BYTES = 256 * 1024; // 256 KB
const MAX_TOTAL_BODY_BYTES = 2 * 1024 * 1024; // 2 MB

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export async function handleGoogleAuth(request, env, corsHeaders) {
  try {
    if (!env.GOOGLE_CLIENT_ID) {
      return jsonResponse({ error: 'Google sign-in is not configured on this server' }, 501, corsHeaders);
    }
    if (!env.SESSION_SECRET) {
      return jsonResponse({ error: 'Server misconfigured: missing SESSION_SECRET' }, 500, corsHeaders);
    }
    const { idToken } = await request.json();
    if (!idToken) return jsonResponse({ error: 'Missing idToken' }, 400, corsHeaders);

    const verified = await verifyGoogleIdToken(idToken, env.GOOGLE_CLIENT_ID);
    const db = env.DB;
    if (!db) return jsonResponse({ error: 'D1 database binding missing' }, 500, corsHeaders);

    // Look for existing account with this google_sub
    let account = await db
      .prepare('SELECT id, email FROM accounts WHERE google_sub = ?')
      .bind(verified.sub)
      .first();

    let accountId = account?.id;
    if (!accountId) {
      accountId = crypto.randomUUID();
      await db
        .prepare('INSERT INTO accounts (id, google_sub, code_hash, email, created_at) VALUES (?, ?, NULL, ?, ?)')
        .bind(accountId, verified.sub, verified.email, Date.now())
        .run();
    } else if (verified.email && account.email !== verified.email) {
      // Update email if changed
      await db
        .prepare('UPDATE accounts SET email = ? WHERE id = ?')
        .bind(verified.email, accountId)
        .run();
    }

    const token = await createSessionToken(accountId, env.SESSION_SECRET);

    return jsonResponse({
      token,
      accountId,
      email: verified.email,
    }, 200, corsHeaders);
  } catch (err) {
    console.error('[Auth Google Error]', err);
    return jsonResponse({ error: err.message || 'Google authentication failed' }, 401, corsHeaders);
  }
}

export async function handleCodeAuthNew(request, env, corsHeaders) {
  try {
    if (!env.SESSION_SECRET) {
      return jsonResponse({ error: 'Server misconfigured: missing SESSION_SECRET' }, 500, corsHeaders);
    }
    const db = env.DB;
    if (!db) return jsonResponse({ error: 'D1 database binding missing' }, 500, corsHeaders);

    const code = generateSyncCode();
    const codeHash = await hashSyncCode(code);
    const accountId = crypto.randomUUID();

    await db
      .prepare('INSERT INTO accounts (id, google_sub, code_hash, email, created_at) VALUES (?, NULL, ?, NULL, ?)')
      .bind(accountId, codeHash, Date.now())
      .run();

    const token = await createSessionToken(accountId, env.SESSION_SECRET);

    return jsonResponse({
      code,
      token,
      accountId,
    }, 200, corsHeaders);
  } catch (err) {
    console.error('[Code Auth New Error]', err);
    return jsonResponse({ error: err.message || 'Failed to create sync code' }, 500, corsHeaders);
  }
}

export async function handleCodeAuth(request, env, corsHeaders) {
  try {
    if (!env.SESSION_SECRET) {
      return jsonResponse({ error: 'Server misconfigured: missing SESSION_SECRET' }, 500, corsHeaders);
    }
    const { code } = await request.json();
    if (!code) return jsonResponse({ error: 'Missing code' }, 400, corsHeaders);

    const db = env.DB;
    if (!db) return jsonResponse({ error: 'D1 database binding missing' }, 500, corsHeaders);

    const codeHash = await hashSyncCode(code);
    const account = await db
      .prepare('SELECT id, email FROM accounts WHERE code_hash = ?')
      .bind(codeHash)
      .first();

    if (!account) {
      return jsonResponse({ error: 'Invalid or unknown sync code' }, 401, corsHeaders);
    }

    const token = await createSessionToken(account.id, env.SESSION_SECRET);

    return jsonResponse({
      token,
      accountId: account.id,
      email: account.email || null,
    }, 200, corsHeaders);
  } catch (err) {
    console.error('[Code Auth Error]', err);
    return jsonResponse({ error: err.message || 'Authentication with code failed' }, 500, corsHeaders);
  }
}

export async function handleLinkGoogle(request, env, accountId, corsHeaders) {
  try {
    if (!env.GOOGLE_CLIENT_ID) {
      return jsonResponse({ error: 'Google sign-in is not configured on this server' }, 501, corsHeaders);
    }
    const { idToken } = await request.json();
    if (!idToken) return jsonResponse({ error: 'Missing idToken' }, 400, corsHeaders);

    const verified = await verifyGoogleIdToken(idToken, env.GOOGLE_CLIENT_ID);
    const db = env.DB;
    if (!db) return jsonResponse({ error: 'D1 database binding missing' }, 500, corsHeaders);

    // Check if google_sub already linked to another account
    const existing = await db
      .prepare('SELECT id FROM accounts WHERE google_sub = ? AND id != ?')
      .bind(verified.sub, accountId)
      .first();

    if (existing) {
      return jsonResponse({ error: 'This Google account is already linked to another sync profile' }, 409, corsHeaders);
    }

    await db
      .prepare('UPDATE accounts SET google_sub = ?, email = ? WHERE id = ?')
      .bind(verified.sub, verified.email, accountId)
      .run();

    return jsonResponse({ success: true, email: verified.email }, 200, corsHeaders);
  } catch (err) {
    console.error('[Link Google Error]', err);
    return jsonResponse({ error: err.message || 'Linking Google account failed' }, 500, corsHeaders);
  }
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export async function handleGetSync(request, env, accountId, corsHeaders, appOverride = null) {
  try {
    const url = new URL(request.url);
    const app = appOverride || url.searchParams.get('app') || 'hr';
    const db = env.DB;
    if (!db) return jsonResponse({ error: 'D1 database binding missing' }, 500, corsHeaders);

    const now = Date.now();
    // Prune expired tombstones older than 30 days
    try {
      await db
        .prepare('DELETE FROM kv WHERE account_id = ? AND app = ? AND deleted = 1 AND updated_at < ?')
        .bind(accountId, app, now - THIRTY_DAYS_MS)
        .run();
    } catch (pruneErr) {
      console.warn('[Sync Prune Error]', pruneErr);
    }

    const { results } = await db
      .prepare('SELECT key, value, updated_at, deleted FROM kv WHERE account_id = ? AND app = ?')
      .bind(accountId, app)
      .all();

    const keys = {};
    if (Array.isArray(results)) {
      for (const row of results) {
        let val = null;
        if (!row.deleted) {
          try {
            val = JSON.parse(row.value);
          } catch {
            val = row.value;
          }
        }
        keys[row.key] = {
          value: val,
          updatedAt: row.updated_at,
          deleted: !!row.deleted,
        };
      }
    }

    return jsonResponse({ keys }, 200, corsHeaders);
  } catch (err) {
    console.error('[Get Sync Error]', err);
    return jsonResponse({ error: err.message || 'Failed to fetch sync state' }, 500, corsHeaders);
  }
}

export async function handlePutSync(request, env, accountId, corsHeaders) {
  try {
    const rawBody = await request.text();
    if (rawBody.length > MAX_TOTAL_BODY_BYTES) {
      return jsonResponse({ error: 'Payload exceeds 2MB limit' }, 413, corsHeaders);
    }

    const { app = 'hr', changes = {} } = JSON.parse(rawBody);
    const db = env.DB;
    if (!db) return jsonResponse({ error: 'D1 database binding missing' }, 500, corsHeaders);

    const entries = Object.entries(changes);
    if (entries.length === 0) {
      return handleGetSync(request, env, accountId, corsHeaders, app);
    }

    // Fetch existing keys and timestamps for this account & app in a single query
    const { results } = await db
      .prepare('SELECT key, updated_at, deleted FROM kv WHERE account_id = ? AND app = ?')
      .bind(accountId, app)
      .all();

    const existingMap = new Map();
    if (Array.isArray(results)) {
      for (const row of results) {
        existingMap.set(row.key, { updatedAt: row.updated_at, deleted: !!row.deleted });
      }
    }

    const statements = [];

    // Process each changed key
    for (const [key, change] of entries) {
      if (!change) continue;
      const incomingValStr = change.value !== undefined ? JSON.stringify(change.value) : 'null';
      if (incomingValStr.length > MAX_KEY_SIZE_BYTES) {
        return jsonResponse({ error: `Key "${key}" exceeds 256KB limit` }, 413, corsHeaders);
      }

      const incomingUpdatedAt = Number(change.updatedAt) || Date.now();
      const isDeleted = !!change.deleted;

      if (existingMap.has(key)) {
        const existing = existingMap.get(key);
        if (incomingUpdatedAt >= existing.updatedAt) {
          statements.push(
            db.prepare('UPDATE kv SET value = ?, updated_at = ?, deleted = ? WHERE account_id = ? AND app = ? AND key = ?')
              .bind(isDeleted ? 'null' : incomingValStr, incomingUpdatedAt, isDeleted ? 1 : 0, accountId, app, key)
          );
        }
      } else {
        statements.push(
          db.prepare('INSERT INTO kv (account_id, app, key, value, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(accountId, app, key, isDeleted ? 'null' : incomingValStr, incomingUpdatedAt, isDeleted ? 1 : 0)
        );
      }
    }

    if (statements.length > 0) {
      await db.batch(statements);
    }

    // Return the full merged state for this app
    return handleGetSync(request, env, accountId, corsHeaders, app);
  } catch (err) {
    console.error('[Put Sync Error]', err);
    return jsonResponse({ error: err.message || 'Failed to update sync state' }, 500, corsHeaders);
  }
}

export async function handleDeleteSync(request, env, accountId, corsHeaders) {
  try {
    const url = new URL(request.url);
    const app = url.searchParams.get('app');
    const db = env.DB;
    if (!db) return jsonResponse({ error: 'D1 database binding missing' }, 500, corsHeaders);

    if (app) {
      await db.prepare('DELETE FROM kv WHERE account_id = ? AND app = ?').bind(accountId, app).run();
      const remaining = await db
        .prepare('SELECT 1 FROM kv WHERE account_id = ? LIMIT 1')
        .bind(accountId)
        .first();
      if (!remaining) {
        await db.batch([
          db.prepare('DELETE FROM devices WHERE account_id = ?').bind(accountId),
          db.prepare('DELETE FROM accounts WHERE id = ?').bind(accountId),
        ]);
      }
    } else {
      await db.batch([
        db.prepare('DELETE FROM kv WHERE account_id = ?').bind(accountId),
        db.prepare('DELETE FROM devices WHERE account_id = ?').bind(accountId),
        db.prepare('DELETE FROM accounts WHERE id = ?').bind(accountId),
      ]);
    }

    return jsonResponse({ success: true }, 200, corsHeaders);
  } catch (err) {
    console.error('[Delete Sync Error]', err);
    return jsonResponse({ error: err.message || 'Failed to delete sync data' }, 500, corsHeaders);
  }
}

export async function handlePutDevice(request, env, accountId, corsHeaders) {
  try {
    const { deviceId, subscription, label } = await request.json();
    if (!deviceId || !subscription) {
      return jsonResponse({ error: 'Missing deviceId or subscription' }, 400, corsHeaders);
    }

    const db = env.DB;
    if (!db) return jsonResponse({ error: 'D1 database binding missing' }, 500, corsHeaders);

    const subStr = typeof subscription === 'string' ? subscription : JSON.stringify(subscription);
    const now = Date.now();

    await db
      .prepare(`
        INSERT INTO devices (account_id, device_id, subscription, label, last_seen)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(account_id, device_id) DO UPDATE SET
          subscription = excluded.subscription,
          label = excluded.label,
          last_seen = excluded.last_seen
      `)
      .bind(accountId, deviceId, subStr, label || null, now)
      .run();

    return jsonResponse({ success: true }, 200, corsHeaders);
  } catch (err) {
    console.error('[Put Device Error]', err);
    return jsonResponse({ error: err.message || 'Failed to register device' }, 500, corsHeaders);
  }
}

export async function handleDeleteDevice(request, env, accountId, deviceId, corsHeaders) {
  try {
    const db = env.DB;
    if (!db) return jsonResponse({ error: 'D1 database binding missing' }, 500, corsHeaders);

    await db
      .prepare('DELETE FROM devices WHERE account_id = ? AND device_id = ?')
      .bind(accountId, deviceId)
      .run();

    return jsonResponse({ success: true }, 200, corsHeaders);
  } catch (err) {
    console.error('[Delete Device Error]', err);
    return jsonResponse({ error: err.message || 'Failed to remove device' }, 500, corsHeaders);
  }
}
