// lib/xero.js — Xero OAuth 2.0 + accounting API helpers
// Scopes: accounting.contacts accounting.transactions offline_access
// Docs: https://developer.xero.com/documentation/

import { getDb } from './db.js';

const XERO_AUTH_URL    = 'https://login.xero.com/identity/connect/authorize';
const XERO_TOKEN_URL   = 'https://identity.xero.com/connect/token';
const XERO_API_BASE    = 'https://api.xero.com/api.xro/2.0';
const XERO_CONN_URL    = 'https://api.xero.com/connections';

const CLIENT_ID     = process.env.XERO_CLIENT_ID;
const CLIENT_SECRET = process.env.XERO_CLIENT_SECRET;
const REDIRECT_URI  = process.env.XERO_REDIRECT_URI;

// ── OAuth helpers ─────────────────────────────────────────────────────────────

export function getXeroAuthUrl(state = '') {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    scope:         'accounting.contacts accounting.transactions offline_access',
    state,
  });
  return `${XERO_AUTH_URL}?${params}`;
}

export async function exchangeXeroCode(code) {
  const res = await fetch(XERO_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      Authorization:   'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
    },
    body: new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Xero token exchange failed: ${res.status} ${t}`);
  }
  return res.json(); // { access_token, refresh_token, expires_in, token_type }
}

export async function getXeroTenantId(accessToken) {
  const res = await fetch(XERO_CONN_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Xero connections failed: ${res.status}`);
  const conns = await res.json();
  if (!conns.length) throw new Error('No Xero organisations connected');
  return conns[0].tenantId;
}

// ── Token storage ─────────────────────────────────────────────────────────────

export async function saveXeroTokens(clientId, { access_token, refresh_token, expires_in, tenant_id }) {
  const db = getDb();
  const expires_at = new Date(Date.now() + expires_in * 1000).toISOString();
  await db.from('integration_tokens').upsert({
    client_id:     clientId,
    integration:   'xero',
    access_token,
    refresh_token,
    expires_at,
    tenant_id,
    updated_at:    new Date().toISOString(),
  }, { onConflict: 'client_id,integration' });
}

async function refreshXeroToken(clientId, refreshToken) {
  const res = await fetch(XERO_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      Authorization:   'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
    },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Xero token refresh failed: ${res.status} ${t}`);
  }
  const tokens = await res.json();
  await saveXeroTokens(clientId, { ...tokens, tenant_id: undefined });
  return tokens.access_token;
}

/** Load Xero tokens for a client; auto-refresh if expiring soon. */
export async function getXeroClient(clientId) {
  const db = getDb();
  const { data, error } = await db
    .from('integration_tokens')
    .select('*')
    .eq('client_id', clientId)
    .eq('integration', 'xero')
    .single();

  if (error || !data?.access_token) {
    throw new Error('Xero not connected — complete OAuth via /api/auth/xero');
  }

  let { access_token, refresh_token, expires_at, tenant_id } = data;

  // Refresh if expiring within 5 minutes
  if (expires_at && new Date(expires_at) < new Date(Date.now() + 5 * 60 * 1000)) {
    access_token = await refreshXeroToken(clientId, refresh_token);
  }

  return { accessToken: access_token, tenantId: tenant_id };
}

// ── Contacts ──────────────────────────────────────────────────────────────────

export async function syncContacts(accessToken, tenantId) {
  const res = await xeroGet(accessToken, tenantId, '/Contacts?summaryOnly=true');
  return (res.Contacts || []).map(c => ({
    xero_id:   c.ContactID,
    name:      c.Name,
    email:     c.EmailAddress || null,
    phone:     c.Phones?.[0]?.PhoneNumber || null,
  }));
}

export async function findOrCreateContact(accessToken, tenantId, { name, email }) {
  // Search by email
  if (email) {
    try {
      const res = await xeroGet(accessToken, tenantId, `/Contacts?where=EmailAddress=="${encodeURIComponent(email)}"`);
      if (res.Contacts?.length) return res.Contacts[0].ContactID;
    } catch { /* fall through */ }
  }

  // Create contact
  const res = await xeroPost(accessToken, tenantId, '/Contacts', {
    Contacts: [{ Name: name || email || 'Unknown Contact', EmailAddress: email || '' }],
  });
  return res.Contacts?.[0]?.ContactID;
}

// ── Quotes ────────────────────────────────────────────────────────────────────

export async function createXeroQuote(accessToken, tenantId, {
  contactId,
  lineItems,
  reference,
  title,
  summary,
}) {
  const payload = {
    Quotes: [{
      Contact:   { ContactID: contactId },
      LineItems: (lineItems || []).map(mapLineItem),
      Reference: reference || '',
      Title:     title || 'Quote',
      Summary:   summary || '',
      Status:    'DRAFT',
      LineAmountTypes: 'EXCLUSIVE',
    }],
  };

  const res = await xeroPost(accessToken, tenantId, '/Quotes', payload);
  const q   = res.Quotes?.[0];
  return {
    quote_id:     q?.QuoteID,
    quote_number: q?.QuoteNumber,
    url:          q?.QuoteID ? `https://go.xero.com/Quotes/EditQuote.aspx?quoteID=${q.QuoteID}` : null,
  };
}

// ── Invoices ──────────────────────────────────────────────────────────────────

export async function createXeroInvoice(accessToken, tenantId, {
  contactId,
  lineItems,
  reference,
  dueDays,
}) {
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + (dueDays || 14));
  const dueDateStr = dueDate.toISOString().split('T')[0];

  const payload = {
    Invoices: [{
      Type:      'ACCREC',
      Contact:   { ContactID: contactId },
      LineItems: (lineItems || []).map(mapLineItem),
      Reference: reference || '',
      DueDate:   dueDateStr,
      Status:    'DRAFT',
      LineAmountTypes: 'EXCLUSIVE',
    }],
  };

  const res = await xeroPost(accessToken, tenantId, '/Invoices', payload);
  const inv = res.Invoices?.[0];
  return {
    invoice_id:     inv?.InvoiceID,
    invoice_number: inv?.InvoiceNumber,
    url:            inv?.InvoiceID ? `https://go.xero.com/AccountsReceivable/Edit.aspx?InvoiceID=${inv.InvoiceID}` : null,
  };
}

// ── Internals ─────────────────────────────────────────────────────────────────

function xeroHeaders(accessToken, tenantId) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Xero-tenant-id': tenantId,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function xeroGet(accessToken, tenantId, path) {
  const res = await fetch(`${XERO_API_BASE}${path}`, {
    headers: xeroHeaders(accessToken, tenantId),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Xero GET ${path} → ${res.status}: ${t}`);
  }
  return res.json();
}

async function xeroPost(accessToken, tenantId, path, body) {
  const res = await fetch(`${XERO_API_BASE}${path}`, {
    method: 'POST',
    headers: xeroHeaders(accessToken, tenantId),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Xero POST ${path} → ${res.status}: ${t}`);
  }
  return res.json();
}

function mapLineItem(item) {
  return {
    Description: item.description || item.desc || item.name || 'Service',
    Quantity:    item.qty || item.quantity || 1,
    UnitAmount:  item.rate || item.unit_price || 0,
    AccountCode: '200',
    TaxType:     'OUTPUT2', // Australian GST
  };
}
