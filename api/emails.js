// api/emails.js — Fetch, triage, and cache emails for the authenticated client
import { getSession } from '../lib/session.js';
import { getDb } from '../lib/db.js';
import { fetchEmails } from '../lib/gmail.js';
import { triageEmail } from '../lib/gemini.js';

export default async function handler(req, res) {
  const client = await getSession(req);
  if (!client) return res.status(401).json({ error: 'Not authenticated' });

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const forceRefresh = req.query.refresh === '1';
  const db = getDb();

  // ── Serve from cache unless forceRefresh ──────────────────────────────
  if (!forceRefresh) {
    const { data: cached } = await db
      .from('email_cache')
      .select('*')
      .eq('client_id', client.id)
      .order('received_at', { ascending: false })
      .limit(50);

    if (cached && cached.length > 0) {
      return res.status(200).json({ emails: cached, source: 'cache' });
    }
  }

  // ── Fetch fresh emails from Gmail ─────────────────────────────────────
  let rawEmails;
  try {
    rawEmails = await fetchEmails(client.id, 30);
  } catch (err) {
    console.error('[emails] Gmail fetch failed:', err.message);
    return res.status(502).json({ error: 'Failed to fetch emails from Gmail', details: err.message });
  }

  if (rawEmails.length === 0) {
    return res.status(200).json({ emails: [], source: 'gmail' });
  }

  // ── Load business profile + learned rules for Gemini context ──────────
  const [{ data: profileRow }, { data: learnedRows }] = await Promise.all([
    db.from('business_profiles').select('profile').eq('client_id', client.id).single(),
    db.from('learned_rules').select('original_subject, original_body, edited_reply')
      .eq('client_id', client.id)
      .order('created_at', { ascending: false })
      .limit(10),
  ]);

  const business    = profileRow?.profile || {};
  const learnedRules = learnedRows || [];

  // ── Check which emails we've already triaged ──────────────────────────
  const gmailIds = rawEmails.map(e => e.gmail_message_id);
  const { data: existingCached } = await db
    .from('email_cache')
    .select('gmail_message_id')
    .eq('client_id', client.id)
    .in('gmail_message_id', gmailIds);

  const alreadyCached = new Set((existingCached || []).map(e => e.gmail_message_id));
  const toTriage = rawEmails.filter(e => !alreadyCached.has(e.gmail_message_id));

  // ── Triage new emails with Gemini ─────────────────────────────────────
  const triaged = await Promise.all(
    toTriage.map(async email => {
      try {
        const { category, draft } = await triageEmail(email, business, learnedRules);
        return { ...email, client_id: client.id, category, draft };
      } catch (err) {
        console.error('[triage] Failed for', email.gmail_message_id, err.message);
        return { ...email, client_id: client.id, category: 'inbox', draft: '' };
      }
    })
  );

  // ── Upsert newly triaged emails into cache ────────────────────────────
  if (triaged.length > 0) {
    await db.from('email_cache').upsert(triaged, { onConflict: 'client_id,gmail_message_id' });
  }

  // ── Return all emails for this client ─────────────────────────────────
  const { data: allEmails } = await db
    .from('email_cache')
    .select('*')
    .eq('client_id', client.id)
    .order('received_at', { ascending: false })
    .limit(50);

  return res.status(200).json({ emails: allEmails || [], source: 'gmail' });
}
