import webpush from 'web-push';

// Helper to handle CORS for your GitHub Pages frontend
const corsHeaders = {
  'Access-Control-Allow-Origin': '*', // You can restrict this to your github pages URL later
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    // Handle CORS preflight requests from the browser
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // ========================================================================
    // ROUTE 1: /schedule (Called by your GitHub Pages frontend)
    // ========================================================================
    if (url.pathname === '/schedule' && request.method === 'POST') {
      const { subscription, delay, payload } = await request.json();

      // We tell QStash to hold the message, and then POST to our /webhook route
      const webhookUrl = `${url.origin}/webhook`;

      const qstashRes = await fetch(env.QSTASH_URL + webhookUrl, {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${env.QSTASH_TOKEN}`,
					'Content-Type': 'application/json',
					'Upstash-Delay': `${delay}s`,
					'Upstash-Forward-Authorization': `Bearer ${env.INTERNAL_SECRET}`
				},
				body: JSON.stringify({ subscription, payload })
			});

			const qstashData = await qstashRes.json();

			// NEW: This will print the full structure to your Cloudflare Logs
			console.log("QSTASH FULL RESPONSE:", JSON.stringify(qstashData));

			// Check if it failed
			if (!qstashRes.ok) {
					return new Response(JSON.stringify({ error: "QStash request failed", details: qstashData }), { status: 500 });
			}

			// Update this line to use the correct key found in your logs
			// (If logs show 'id', change this to qstashData.id)
			return new Response(JSON.stringify({ messageId: qstashData.messageId || qstashData.id }), {
				headers: { 'Content-Type': 'application/json', ...corsHeaders }
			});
    }

    // ========================================================================
    // ROUTE 2: /cancel (Called by your GitHub Pages frontend)
    // ========================================================================
    if (url.pathname === '/cancel' && request.method === 'POST') {
      const { messageId } = await request.json();

      await fetch(env.QSTASH_MESSAGES_URL + messageId, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${env.QSTASH_TOKEN}` }
      });

      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // ========================================================================
    // ROUTE 3: /webhook (Called by QStash when the timer finishes)
    // ========================================================================
    if (url.pathname === '/webhook' && request.method === 'POST') {
      // Security Check: Ensure this request actually came from our QStash forwarder
      const authHeader = request.headers.get('Authorization');
      if (authHeader !== `Bearer ${env.INTERNAL_SECRET}`) {
        return new Response('Unauthorized', { status: 401 });
      }

      const { subscription, payload } = await request.json();

      webpush.setVapidDetails(
        env.VAPID_SUBJECT,
        env.VAPID_PUBLIC_KEY,
        env.VAPID_PRIVATE_KEY
      );

      try {
        await webpush.sendNotification(subscription, JSON.stringify(payload));
        return new Response('Push sent', { status: 200 });
      } catch (error) {
        console.error(
          "Push failed — statusCode:", error.statusCode,
          "| body:", error.body,
          "| endpoint:", subscription?.endpoint,
          "| full:", JSON.stringify(error, Object.getOwnPropertyNames(error))
        );
        return new Response(
          JSON.stringify({ error: error.message, statusCode: error.statusCode, body: error.body }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    return new Response('Not Found', { status: 404 });
  }
};
