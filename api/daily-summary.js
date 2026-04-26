/**
 * OTW Receptionist â Daily Summary Email
 * Vercel Cron: runs daily at 7am AEST (21:00 UTC)
 * Fetches all active clients from Supabase, queries call data, sends digest to andy@otwstudios.com.au
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const OTW_FROM_EMAIL = process.env.OTW_FROM_EMAIL || 'andy@otwstudios.com.au';
const ANDY_EMAIL = 'andy@otwstudios.com.au';
const RETELL_API_KEY = process.env.RETELL_API_KEY;

// âââ Helpers ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

async function supabaseQuery(table, query = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Supabase ${table} error: ${await res.text()}`);
  return res.json();
}

async function getRetellCalls(agentId, sinceTimestamp) {
  try {
    const res = await fetch('https://api.retellai.com/v2/list-calls', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RETELL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filter_criteria: {
          agent_id: [agentId],
          start_timestamp: sinceTimestamp,
        },
        sort_order: 'descending',
        limit: 100,
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.calls || [];
  } catch {
    return [];
  }
}

function formatDuration(seconds) {
  if (!seconds) return '0s';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function formatAESTDate(date) {
  return date.toLocaleString('en-AU', {
    timeZone: 'Australia/Perth',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

// âââ Email Template âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function buildDailySummaryEmail(clients, reportDate) {
  const dateStr = formatAESTDate(reportDate);
  const totalClients = clients.length;
  const totalCalls = clients.reduce((sum, c) => sum + (c.calls?.length || 0), 0);
  const totalMinutes = clients.reduce((sum, c) => {
    return sum + (c.calls || []).reduce((s, call) => s + (call.duration_ms ? Math.round(call.duration_ms / 1000) : 0), 0);
  }, 0);

  const clientRows = clients
    .map((c) => {
      const callCount = c.calls?.length || 0;
      const avgDur = callCount > 0
        ? formatDuration(Math.round(c.calls.reduce((s, call) => s + (call.duration_ms ? call.duration_ms / 1000 : 0), 0) / callCount))
        : 'â';

      const statusDot = c.status === 'active'
        ? '<span style="color:#22C55E">â</span>'
        : '<span style="color:#EF4444">â</span>';

      return `
        <tr style="border-bottom:1px solid rgba(255,255,255,0.06)">
          <td style="padding:12px 16px;font-size:13px;color:#E2E8F0">${statusDot} ${c.business_name || 'â'}</td>
          <td style="padding:12px 16px;font-size:13px;color:#94A3B8">${c.owner_name || 'â'}</td>
          <td style="padding:12px 16px;font-size:13px;color:#E2E8F0;text-align:center">${callCount}</td>
          <td style="padding:12px 16px;font-size:13px;color:#94A3B8;text-align:center">${avgDur}</td>
          <td style="padding:12px 16px;font-size:13px;color:#64748B">${c.phone_number || c.retell_phone_number || 'â'}</td>
        </tr>`;
    })
    .join('');

  // Recent call activity across all clients (top 10)
  const allCalls = clients
    .flatMap((c) =>
      (c.calls || []).map((call) => ({
        ...call,
        business: c.business_name,
      }))
    )
    .sort((a, b) => b.start_timestamp - a.start_timestamp)
    .slice(0, 10);

  const recentCallRows = allCalls.length > 0
    ? allCalls.map((call) => {
        const time = new Date(call.start_timestamp).toLocaleString('en-AU', {
          timeZone: 'Australia/Perth',
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
        });
        const dur = formatDuration(call.duration_ms ? Math.round(call.duration_ms / 1000) : 0);
        const sentiment = call.call_analysis?.user_sentiment || 'â';
        const sentimentColor = sentiment === 'Positive' ? '#22C55E' : sentiment === 'Negative' ? '#EF4444' : '#94A3B8';
        return `
          <tr style="border-bottom:1px solid rgba(255,255,255,0.06)">
            <td style="padding:10px 14px;font-size:12px;color:#64748B">${time}</td>
            <td style="padding:10px 14px;font-size:12px;color:#E2E8F0">${call.business}</td>
            <td style="padding:10px 14px;font-size:12px;color:#94A3B8">${dur}</td>
            <td style="padding:10px 14px;font-size:12px;color:${sentimentColor}">${sentiment}</td>
            <td style="padding:10px 14px;font-size:12px;color:#64748B;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${call.call_analysis?.call_summary?.substring(0, 80) || 'â'}</td>
          </tr>`;
      }).join('')
    : `<tr><td colspan="5" style="padding:20px;text-align:center;color:#64748B;font-size:13px">No calls in the last 24 hours</td></tr>`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0F172A;font-family:'Inter',system-ui,-apple-system,sans-serif">
  <div style="max-width:700px;margin:0 auto;padding:32px 16px">

    <!-- Header -->
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:32px">
      <div style="width:8px;height:8px;border-radius:50%;background:#F59E0B;flex-shrink:0"></div>
      <span style="font-size:14px;font-weight:800;color:#F1F5F9;letter-spacing:-0.01em">OTW Studios</span>
      <span style="font-size:9px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#F59E0B;margin-left:4px">RECEPTIONIST</span>
    </div>

    <!-- Title -->
    <h1 style="font-size:28px;font-weight:900;color:#F1F5F9;margin:0 0 6px;letter-spacing:-0.03em">
      Daily Summary
    </h1>
    <p style="font-size:13px;color:#64748B;margin:0 0 32px">${dateStr}</p>

    <!-- Stats row -->
    <div style="display:flex;gap:12px;margin-bottom:28px">
      <div style="flex:1;background:#1E293B;border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:18px">
        <div style="font-size:9px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#F59E0B;margin-bottom:8px">ACTIVE CLIENTS</div>
        <div style="font-size:32px;font-weight:900;color:#F1F5F9;letter-spacing:-0.03em">${totalClients}</div>
      </div>
      <div style="flex:1;background:#1E293B;border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:18px">
        <div style="font-size:9px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#F59E0B;margin-bottom:8px">CALLS TODAY</div>
        <div style="font-size:32px;font-weight:900;color:#F1F5F9;letter-spacing:-0.03em">${totalCalls}</div>
      </div>
      <div style="flex:1;background:#1E293B;border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:18px">
        <div style="font-size:9px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#F59E0B;margin-bottom:8px">TOTAL TALK TIME</div>
        <div style="font-size:32px;font-weight:900;color:#F1F5F9;letter-spacing:-0.03em">${formatDuration(totalMinutes)}</div>
      </div>
    </div>

    <!-- Client table -->
    <div style="background:#1E293B;border:1px solid rgba(255,255,255,0.06);border-radius:12px;overflow:hidden;margin-bottom:24px">
      <div style="padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.06)">
        <div style="font-size:9px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#F59E0B">CLIENT OVERVIEW</div>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="background:rgba(0,0,0,0.2)">
            <th style="padding:10px 16px;text-align:left;font-size:10px;font-weight:600;color:#64748B;letter-spacing:0.06em;text-transform:uppercase">Business</th>
            <th style="padding:10px 16px;text-align:left;font-size:10px;font-weight:600;color:#64748B;letter-spacing:0.06em;text-transform:uppercase">Owner</th>
            <th style="padding:10px 16px;text-align:center;font-size:10px;font-weight:600;color:#64748B;letter-spacing:0.06em;text-transform:uppercase">Calls</th>
            <th style="padding:10px 16px;text-align:center;font-size:10px;font-weight:600;color:#64748B;letter-spacing:0.06em;text-transform:uppercase">Avg Dur</th>
            <th style="padding:10px 16px;text-align:left;font-size:10px;font-weight:600;color:#64748B;letter-spacing:0.06em;text-transform:uppercase">Phone</th>
          </tr>
        </thead>
        <tbody>${clientRows || '<tr><td colspan="5" style="padding:20px;text-align:center;color:#64748B">No active clients</td></tr>'}</tbody>
      </table>
    </div>

    <!-- Recent calls -->
    <div style="background:#1E293B;border:1px solid rgba(255,255,255,0.06);border-radius:12px;overflow:hidden;margin-bottom:32px">
      <div style="padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.06)">
        <div style="font-size:9px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#F59E0B">RECENT CALLS (LAST 24H)</div>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="background:rgba(0,0,0,0.2)">
            <th style="padding:8px 14px;text-align:left;font-size:10px;font-weight:600;color:#64748B;letter-spacing:0.06em;text-transform:uppercase">Time</th>
            <th style="padding:8px 14px;text-align:left;font-size:10px;font-weight:600;color:#64748B;letter-spacing:0.06em;text-transform:uppercase">Client</th>
            <th style="padding:8px 14px;text-align:left;font-size:10px;font-weight:600;color:#64748B;letter-spacing:0.06em;text-transform:uppercase">Dur</th>
            <th style="padding:8px 14px;text-align:left;font-size:10px;font-weight:600;color:#64748B;letter-spacing:0.06em;text-transform:uppercase">Sentiment</th>
            <th style="padding:8px 14px;text-align:left;font-size:10px;font-weight:600;color:#64748B;letter-spacing:0.06em;text-transform:uppercase">Summary</th>
          </tr>
        </thead>
        <tbody>${recentCallRows}</tbody>
      </table>
    </div>

    <!-- CTA -->
    <div style="text-align:center;margin-bottom:32px">
      <a href="https://otwstudios.com.au" style="display:inline-block;background:#F59E0B;color:#04080F;font-size:13px;font-weight:800;padding:12px 28px;border-radius:50px;text-decoration:none;letter-spacing:-0.01em">
        Open OTW Dashboard â
      </a>
    </div>

    <!-- Footer -->
    <p style="text-align:center;font-size:10px;color:rgba(148,163,184,0.4);margin:0">
      Powered by OTW Studios Â· Daily digest sent at 7am AWST
    </p>
  </div>
</body>
</html>`;
}

// âââ Main handler ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

export default async function handler(req, res) {
  // Verify cron secret to prevent unauthorized calls
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const now = new Date();
    const since24h = now.getTime() - 24 * 60 * 60 * 1000;

    // Fetch all active clients
    const clients = await supabaseQuery(
      'receptionist_clients',
      '?status=eq.active&select=*'
    );

    if (!clients || clients.length === 0) {
      return res.status(200).json({ message: 'No active clients, skipping summary' });
    }

    // Fetch call data for each client
    const clientsWithCalls = await Promise.all(
      clients.map(async (client) => {
        const agentId = client.retell_agent_id;
        const calls = agentId ? await getRetellCalls(agentId, since24h) : [];
        return { ...client, calls };
      })
    );

    // Build and send the email
    const html = buildDailySummaryEmail(clientsWithCalls, now);

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: OTW_FROM_EMAIL,
        to: [ANDY_EMAIL],
        subject: `OTW Daily Summary â ${now.toLocaleDateString('en-AU', { timeZone: 'Australia/Perth', day: 'numeric', month: 'short' })}`,
        html,
      }),
    });

    if (!emailRes.ok) {
      const err = await emailRes.text();
      throw new Error(`Resend error: ${err}`);
    }

    const emailData = await emailRes.json();
    console.log('[daily-summary] Email sent:', emailData.id);

    return res.status(200).json({
      success: true,
      clients: clients.length,
      totalCalls: clientsWithCalls.reduce((s, c) => s + (c.calls?.length || 0), 0),
      emailId: emailData.id,
    });
  } catch (error) {
    console.error('[daily-summary] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
