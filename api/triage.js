// api/triage.js — (Re)generate an AI draft reply for a specific cached email
import { getSession } from '../lib/session.js';
import { getDb } from '../lib/db.js';
import { triageEmail } from '../lib/gemini.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const client = await getSession(req);
  if (!client) return res.status(401).json({ error: 'Not authenticated' });

  const { emailId } = req.body;
  if (!emailId) return res.status(400).json({ error: 'Missing emailId' });

  const db = getDb();

  const { data: email, error: fetchErr } = await db
    .from('email_cache')
    .select('*')
    .eq('id', emailId)
    .eq('client_id', client.id)
    .single();

  if (fetchErr || !email) {
    return res.status(404).json({ error: 'Email not found' });
  }

  const [{ data: profileRow }, { data: learnedRows }] = await Promise.all([
    db.from('business_profiles').select('profile').eq('client_id', client.id).single(),
    db.from('learned_rules')
      .select('original_subject, original_body, edited_reply')
      .eq('client_id', client.id)
      .order('created_at', { ascending: false })
      .limit(10),
  ]);

  const business = profileRow?.profile || {};
  const learnedRules = learnedRows || [];

  let category, draft;
  try {
    const result = await triageEmail(email, business, learnedRules);
    category = result.category;
    draft = result.draft;
  } catch (err) {
    console.error('[triage] Gemini failed:', err.message);
    return res.status(500).json({ error: 'Draft generation failed', details: err.message });
  }

  await db
    .from('email_cache')
    .update({ draft, category })
    .eq('id', emailId)
    .eq('client_id', client.id);

  return res.status(200).json({ draft, category });
}
