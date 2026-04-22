// api/learning.js — Save an edited draft as a learned rule (few-shot example for Gemini)
import { getSession } from '../lib/session.js';
import { getDb } from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const client = await getSession(req);
  if (!client) return res.status(401).json({ error: 'Not authenticated' });

  const { email_cache_id, edited_reply, rule_description } = req.body;

  if (!email_cache_id || !edited_reply) {
    return res.status(400).json({ error: 'Missing email_cache_id or edited_reply' });
  }

  const db = getDb();

  // Load the email for context
  const { data: email } = await db
    .from('email_cache')
    .select('subject, body')
    .eq('id', email_cache_id)
    .eq('client_id', client.id)
    .single();

  // Insert the learned rule
  const { data, error } = await db.from('learned_rules').insert({
    client_id:        client.id,
    original_subject: email?.subject || null,
    original_body:    email?.body    || null,
    edited_reply,
    rule_description: rule_description || null,
  }).select('id, created_at').single();

  if (error) {
    console.error('[learning] Insert failed:', error);
    return res.status(500).json({ error: 'Failed to save learning' });
  }

  // Also update the cached draft so the UI reflects the edit
  await db.from('email_cache').update({ draft: edited_reply })
    .eq('id', email_cache_id).eq('client_id', client.id);

  // Return count of total learned rules for this client
  const { count } = await db
    .from('learned_rules')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', client.id);

  return res.status(200).json({ ok: true, id: data.id, total_rules: count });
}
