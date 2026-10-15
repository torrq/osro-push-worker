import webpush from 'web-push';
import { verifySessionToken } from './auth.js';
import {
  handleGoogleAuth,
  handleCodeAuthNew,
  handleCodeAuth,
  handleLinkGoogle,
  handleGetSync,
  handlePutSync,
  handleDeleteSync,
  handlePutDevice,
  handleDeleteDevice,
} from './sync.js';

// CORS configuration for GitHub Pages & local development
function getCorsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const isAllowed =
    origin === 'https://torrq.github.io' ||
    origin.startsWith('http://localhost:') ||
    origin.startsWith('http://127.0.0.1:');

  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : 'https://torrq.github.io',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function jsonResponse(data, status = 200, headers = {}, corsHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders, ...headers },
  });
}

async function authenticateRequest(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice(7).trim();
  if (!env.SESSION_SECRET) {
    console.error('[Auth] SESSION_SECRET environment variable is missing');
    return null;
  }
  return verifySessionToken(token, env.SESSION_SECRET);
}

export default {
  async fetch(request, env) {
    const corsHeaders = getCorsHeaders(request);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    // ========================================================================
    // AUTH ROUTES (Public)
    // ========================================================================
    if (pathname === '/auth/google' && request.method === 'POST') {
      return handleGoogleAuth(request, env, corsHeaders);
    }

    if (pathname === '/auth/code/new' && request.method === 'POST') {
      return handleCodeAuthNew(request, env, corsHeaders);
    }

    if (pathname === '/auth/code' && request.method === 'POST') {
      return handleCodeAuth(request, env, corsHeaders);
    }

    // ========================================================================
    // AUTHENTICATED USER ROUTES
    // ========================================================================
    if (
      pathname === '/auth/link-google' ||
      pathname === '/sync' ||
      pathname === '/devices' ||
      pathname.startsWith('/devices/')
    ) {
      const session = await authenticateRequest(request, env);
      if (!session) {
        return jsonResponse({ error: 'Unauthorized or expired session' }, 401, {}, corsHeaders);
      }

      if (pathname === '/auth/link-google' && request.method === 'POST') {
        return handleLinkGoogle(request, env, session.accountId, corsHeaders);
      }

      if (pathname === '/sync' && request.method === 'GET') {
        return handleGetSync(request, env, session.accountId, corsHeaders);
      }

      if (pathname === '/sync' && request.method === 'PUT') {
        return handlePutSync(request, env, session.accountId, corsHeaders);
      }

      if (pathname === '/sync' && request.method === 'DELETE') {
        return handleDeleteSync(request, env, session.accountId, corsHeaders);
      }

      if (pathname === '/devices' && request.method === 'PUT') {
        return handlePutDevice(request, env, session.accountId, corsHeaders);
      }

      if (pathname.startsWith('/devices/') && request.method === 'DELETE') {
        const deviceId = decodeURIComponent(pathname.replace('/devices/', '')).trim();
        return handleDeleteDevice(request, env, session.accountId, deviceId, corsHeaders);
      }
    }

    // ========================================================================
    // ROUTE: /schedule (Called by GitHub Pages frontend)
    // ========================================================================
    if (pathname === '/schedule' && request.method === 'POST') {
      const body = await request.json();
      const { subscription, deviceId, delay, payload } = body;

      // Check if user is authenticated
      const session = await authenticateRequest(request, env);
      const accountId = session?.accountId || null;

      // If user is linked, immediately ensure their current device subscription is up-to-date in D1
      if (accountId && deviceId && subscription && env.DB) {
        try {
          const subJson = typeof subscription === 'string' ? subscription : JSON.stringify(subscription);
          await env.DB
            .prepare(`
              INSERT INTO devices (account_id, device_id, subscription, last_seen)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(account_id, device_id) DO UPDATE SET
                subscription = excluded.subscription,
                last_seen = excluded.last_seen
            `)
            .bind(accountId, deviceId, subJson, Date.now())
            .run();
        } catch (devErr) {
          console.warn('[Schedule] Device subscription upsert error:', devErr);
        }
      }

      // We tell QStash to hold the message, then POST to /webhook
      const webhookUrl = `${url.origin}/webhook`;

      // Payload to forward to /webhook: include accountId and subscription fallback
      const forwardBody = {
        accountId: accountId || null,
        subscription: subscription || null,
        payload,
      };

      const qstashRes = await fetch(env.QSTASH_URL + webhookUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.QSTASH_TOKEN}`,
          'Content-Type': 'application/json',
          'Upstash-Delay': `${delay}s`,
          'Upstash-Forward-Authorization': `Bearer ${env.INTERNAL_SECRET}`,
        },
        body: JSON.stringify(forwardBody),
      });

      const qstashData = await qstashRes.json();
      if (!qstashRes.ok) {
        console.error('QStash schedule error:', qstashData);
        return jsonResponse({ error: 'QStash request failed', details: qstashData }, 500, {}, corsHeaders);
      }

      return jsonResponse({
        messageId: qstashData.messageId || qstashData.id,
      }, 200, {}, corsHeaders);
    }

    // ========================================================================
    // ROUTE: /cancel (Called by GitHub Pages frontend)
    // ========================================================================
    if (pathname === '/cancel' && request.method === 'POST') {
      const { messageId } = await request.json();

      if (messageId) {
        await fetch(env.QSTASH_MESSAGES_URL + messageId, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${env.QSTASH_TOKEN}` },
        });
      }

      return jsonResponse({ success: true }, 200, {}, corsHeaders);
    }

    // ========================================================================
    // ROUTE: /webhook (Called by QStash when the timer finishes)
    // ========================================================================
    if (pathname === '/webhook' && request.method === 'POST') {
      // Security Check: verify QStash forwarder secret
      const authHeader = request.headers.get('Authorization');
      if (authHeader !== `Bearer ${env.INTERNAL_SECRET}`) {
        return new Response('Unauthorized', { status: 401 });
      }

      const body = await request.json();
      const { subscription, accountId, payload } = body;

      webpush.setVapidDetails(
        env.VAPID_SUBJECT,
        env.VAPID_PUBLIC_KEY,
        env.VAPID_PRIVATE_KEY
      );

      // Scenario A: User is linked -> Fan out to all user's registered devices
      if (accountId && env.DB) {
        try {
          const { results } = await env.DB
            .prepare('SELECT device_id, subscription FROM devices WHERE account_id = ?')
            .bind(accountId)
            .all();

          if (Array.isArray(results) && results.length > 0) {
            const pushPromises = results.map(async (row) => {
              try {
                const sub = typeof row.subscription === 'string'
                  ? JSON.parse(row.subscription)
                  : row.subscription;
                await webpush.sendNotification(sub, JSON.stringify(payload));
              } catch (pushErr) {
                console.warn(`[Push Error device=${row.device_id}] status=${pushErr.statusCode}`);
                // Stale subscription cleanup (404 Not Found or 410 Gone)
                if (pushErr.statusCode === 404 || pushErr.statusCode === 410) {
                  await env.DB
                    .prepare('DELETE FROM devices WHERE account_id = ? AND device_id = ?')
                    .bind(accountId, row.device_id)
                    .run();
                }
              }
            });

            await Promise.allSettled(pushPromises);
            return new Response('Pushes sent to account devices', { status: 200 });
          }
          // If 0 devices found in DB, fall through to direct subscription push if provided
        } catch (dbErr) {
          console.warn('[Webhook D1 Error, falling back to subscription push]', dbErr);
        }
      }

      // Scenario B: Unlinked user -> Send to single subscription (today's behavior)
      if (subscription) {
        try {
          await webpush.sendNotification(subscription, JSON.stringify(payload));
          return new Response('Push sent', { status: 200 });
        } catch (error) {
          console.error(
            'Push failed — statusCode:', error.statusCode,
            '| body:', error.body,
            '| endpoint:', subscription?.endpoint
          );
          return jsonResponse(
            { error: error.message, statusCode: error.statusCode, body: error.body },
            500
          );
        }
      }

      return jsonResponse({ error: 'No subscription or accountId provided' }, 400);
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  },
};
