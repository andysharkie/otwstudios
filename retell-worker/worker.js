/**
 * OTW Studios — Retell Token Worker
 * Deployed at: https://retell-token.otw-studios.workers.dev
 *
 * Required environment variable (set in Cloudflare Dashboard → Workers → retell-token → Settings → Variables):
 *   RETELL_API_KEY = your Retell API key (from app.retellai.com → API Keys)
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    // ── CORS preflight ──────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    // ── Validate API key is configured ─────────────────────────────
    if (!env.RETELL_API_KEY) {
      console.error('RETELL_API_KEY environment variable is not set');
      return json({ error: 'Server misconfiguration: RETELL_API_KEY not set' }, 500);
    }

    // ── Parse request body ──────────────────────────────────────────
    let agent_id;
    try {
      const body = await request.json();
      agent_id = body.agent_id;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    if (!agent_id) {
      return json({ error: 'Missing required field: agent_id' }, 400);
    }

    // ── Call Retell API to create a web call ────────────────────────
    let retellRes;
    try {
      retellRes = await fetch('https://api.retellai.com/v2/create-web-call', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.RETELL_API_KEY}`,
        },
        body: JSON.stringify({ agent_id }),
      });
    } catch (err) {
      console.error('Retell API network error:', err.message);
      return json({ error: 'Failed to reach Retell API', detail: err.message }, 502);
    }

    // ── Handle Retell API errors ────────────────────────────────────
    if (!retellRes.ok) {
      const errorText = await retellRes.text().catch(() => '(no body)');
      console.error(`Retell API returned ${retellRes.status}:`, errorText);
      return json({
        error: `Retell API error ${retellRes.status}`,
        detail: errorText,
      }, 502);
    }

    // ── Return the access token ─────────────────────────────────────
    const data = await retellRes.json();
    if (!data.access_token) {
      console.error('Retell API response missing access_token:', JSON.stringify(data));
      return json({ error: 'Retell API response missing access_token', raw: data }, 502);
    }

    return json({ access_token: data.access_token });
  },
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
