// api/integrations/servicem8.js
// Creates a job in ServiceM8 from an OTW Receptionist work order.
// Called from the post-call Make.com webhook, or directly from the client dashboard (future).
//
// ServiceM8 API docs: https://developer.servicem8.com/
// Auth: Basic auth with client's ServiceM8 API key (stored in client config)

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // This endpoint is called by the post-call webhook — not by the browser client.
  // Auth: shared webhook secret to prevent unauthenticated calls.
  const authHeader = req.headers['x-otw-webhook-secret'];
  if (authHeader !== process.env.OTW_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  const {
    servicem8_api_key,   // client's ServiceM8 API key
    caller_name,
    caller_phone,
    job_description,
    job_address,
    urgency,             // 'emergency' | 'urgent' | 'routine'
    notes,
    contact_first_name,
    contact_last_name,
  } = req.body;

  if (!servicem8_api_key) {
    return res.status(400).json({ error: 'Missing servicem8_api_key' });
  }

  // ── Build the ServiceM8 job payload ────────────────────────────────────────
  // ServiceM8 job statuses: 'Unscheduled', 'Scheduled', 'In Progress', 'Completed', 'Invoice'
  const jobStatus = urgency === 'emergency' ? 'Scheduled' : 'Unscheduled';

  const jobPayload = {
    status:       jobStatus,
    job_description: job_description || 'New enquiry via OTW Receptionist',
    work_address_1: job_address || '',
    contact_first: contact_first_name || (caller_name || '').split(' ')[0] || '',
    contact_last:  contact_last_name  || (caller_name || '').split(' ').slice(1).join(' ') || '',
    contact_phone: caller_phone || '',
    notes:         buildNotes({ urgency, notes, caller_name, caller_phone }),
  };

  // ── Create the job via ServiceM8 REST API ─────────────────────────────────
  try {
    const smResponse = await fetch('https://api.servicem8.com/api_1.0/job.json', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(servicem8_api_key + ':').toString('base64'),
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(jobPayload),
    });

    if (!smResponse.ok) {
      const errorText = await smResponse.text();
      console.error('[ServiceM8] Job creation failed:', smResponse.status, errorText);
      return res.status(502).json({
        error: 'ServiceM8 job creation failed',
        status: smResponse.status,
        details: errorText,
      });
    }

    // ServiceM8 returns the created job UUID in the Location header
    const locationHeader = smResponse.headers.get('Location') || '';
    const jobUuid = locationHeader.split('/').pop() || null;

    const jobUrl = jobUuid
      ? `https://app.servicem8.com/dispatch#job/${jobUuid}`
      : null;

    console.log('[ServiceM8] Job created:', jobUuid);

    return res.status(200).json({
      ok: true,
      job_uuid: jobUuid,
      job_url:  jobUrl,
      status:   jobStatus,
    });

  } catch (err) {
    console.error('[ServiceM8] Request failed:', err.message);
    return res.status(500).json({ error: 'ServiceM8 request failed', details: err.message });
  }
}

function buildNotes({ urgency, notes, caller_name, caller_phone }) {
  const parts = ['--- Created by OTW Receptionist ---'];
  if (urgency === 'emergency') parts.push('⚠️  EMERGENCY — respond immediately');
  else if (urgency === 'urgent') parts.push('⚡  Urgent — respond within 2 hours');
  if (caller_name)  parts.push(`Caller: ${caller_name}`);
  if (caller_phone) parts.push(`Phone: ${caller_phone}`);
  if (notes) parts.push(`\nCall notes:\n${notes}`);
  return parts.join('\n');
}
