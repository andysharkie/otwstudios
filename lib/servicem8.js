// lib/servicem8.js — ServiceM8 REST API helpers
// Auth: Basic auth — api_key as username, empty password
// Docs: https://developer.servicem8.com/reference
//
// ServiceM8 doesn't have a separate "quote" object; quotes are jobs with status = 'Quote'.
// This lib is used by:
//   - api/servicem8.js        (TriageAI: create jobs/quotes from email triage)
//   - api/integrations/servicem8.js  (Receptionist: create jobs from post-call webhook)

import { getDb } from './db.js';

const SM8_BASE = 'https://api.servicem8.com/api_1.0';

// ── Auth helpers ──────────────────────────────────────────────────────────────

function basicAuth(apiKey) {
  return 'Basic ' + Buffer.from(apiKey + ':').toString('base64');
}

/** Load the ServiceM8 API key stored for a client (gmail_email). Throws if not found. */
export async function getApiKey(clientId) {
  const db = getDb();
  const { data, error } = await db
    .from('integration_settings')
    .select('settings')
    .eq('client_id', clientId)
    .eq('integration', 'servicem8')
    .single();

  if (error || !data?.settings?.api_key) {
    throw new Error('ServiceM8 not connected — save an API key via /api/servicem8?action=connect');
  }
  return data.settings.api_key;
}

/** Save (or update) a ServiceM8 API key for a client. */
export async function saveApiKey(clientId, apiKey) {
  const db = getDb();
  await db.from('integration_settings').upsert({
    client_id: clientId,
    integration: 'servicem8',
    settings: { api_key: apiKey },
    updated_at: new Date().toISOString(),
  }, { onConflict: 'client_id,integration' });
}

// ── Low-level fetch ───────────────────────────────────────────────────────────

async function sm8Fetch(apiKey, path, method = 'GET', body = null) {
  const res = await fetch(`${SM8_BASE}${path}`, {
    method,
    headers: {
      Authorization: basicAuth(apiKey),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ServiceM8 ${method} ${path} → ${res.status}: ${text}`);
  }

  if (method === 'POST' || method === 'PUT') {
    const location = res.headers.get('Location') || '';
    const uuid = location.split('/').pop().replace('.json', '') || null;
    return { uuid, location };
  }

  const ct = res.headers.get('Content-Type') || '';
  return ct.includes('json') ? res.json() : null;
}

// ── Client / contact helpers ──────────────────────────────────────────────────

export async function findOrCreateClient(apiKey, { name, email, phone }) {
  if (email) {
    try {
      const filter = `$filter=contact_email eq '${email}'`;
      const results = await sm8Fetch(apiKey, `/client.json?${encodeURIComponent(filter)}`);
      if (Array.isArray(results) && results.length > 0) {
        return results[0].uuid;
      }
    } catch {
      // filter not supported on all plans — fall through to create
    }
  }

  const nameParts = (name || '').trim().split(/\s+/);
  const payload = {
    name: name || email || 'Unknown Customer',
    contact_first: nameParts[0] || '',
    contact_last:  nameParts.slice(1).join(' ') || '',
    contact_email: email || '',
    contact_phone: phone || '',
  };

  const { uuid } = await sm8Fetch(apiKey, '/client.json', 'POST', payload);
  return uuid;
}

// ── Job creation ──────────────────────────────────────────────────────────────

export async function createJob(apiKey, {
  clientUuid,
  description,
  address,
  urgency,
  notes,
  source,
}) {
  const status = urgency === 'emergency' ? 'Scheduled' : 'Unscheduled';

  const payload = {
    status,
    company_uuid:     clientUuid || undefined,
    job_description:  description || 'New work order',
    work_address_1:   address || '',
    notes:            buildNotes({ urgency, notes, source }),
  };

  const { uuid } = await sm8Fetch(apiKey, '/job.json', 'POST', payload);
  return {
    job_uuid: uuid,
    job_url:  uuid ? `https://app.servicem8.com/dispatch#job/${uuid}` : null,
    status,
  };
}

export async function createQuote(apiKey, {
  clientUuid,
  description,
  address,
  notes,
  source,
  lineItems,
}) {
  const payload = {
    status:          'Quote',
    company_uuid:    clientUuid || undefined,
    job_description: description || 'Quote request',
    work_address_1:  address || '',
    notes:           buildNotes({ notes, source }),
  };

  const { uuid } = await sm8Fetch(apiKey, '/job.json', 'POST', payload);

  if (uuid && Array.isArray(lineItems) && lineItems.length > 0) {
    for (const item of lineItems) {
      await sm8Fetch(apiKey, '/jobmaterial.json', 'POST', {
        job_uuid:   uuid,
        name:       item.description || item.desc || item.name || 'Item',
        quantity:   item.qty || item.quantity || 1,
        unit_price: item.rate || item.unit_price || 0,
      }).catch(err => console.warn('[ServiceM8] Line item add failed:', err.message));
    }
  }

  return {
    job_uuid: uuid,
    job_url:  uuid ? `https://app.servicem8.com/dispatch#job/${uuid}` : null,
    status:   'Quote',
  };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function buildNotes({ urgency, notes, source }) {
  const lines = [`--- Created by OTW Studios${source ? ` · ${source}` : ''} ---`];
  if (urgency === 'emergency') lines.push('⚠️  EMERGENCY — respond immediately');
  else if (urgency === 'urgent') lines.push('⚡  Urgent — respond within 2 hours');
  if (notes) lines.push('', notes);
  return lines.join('\n');
}
