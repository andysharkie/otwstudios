// api/labels.js â List and create Gmail labels for a client
import { getSession } from '../lib/session.js';
import { getDb } from '../lib/db.js';
import { createGmailLabel } from '../lib/gmail.js';

export default async function handler(req, res) {
  const client = await getSession(req);
  if (!client) return res.status(401).json({ error: 'Not authenticated' });

  const db = getDb();

  // ââ GET /api/labels ââ return all labels saved in DB for this client ââ
  if (req.method === 'GET') {
    const { data, error } = await db
      .from('labels')
      .select('id, name, gmail_label_id, color, created_at')
      .eq('client_id', client.id)
      .order('name');

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ labels: data || [] });
  }

  // ââ POST /api/labels ââ create a new label in Gmail + save to DB ââââââ
  if (req.method === 'POST') {
    const { name } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'Missing label name' });

    // Check if label already exists in DB for this client
    const { data: existing } = await db
      .from('labels')
      .select('*')
      .eq('client_id', client.id)
      .ilike('name', name.trim())
      .single();

    if (existing) return res.status(200).json({ label: existing, existed: true });

    try {
      // Create in Gmail
      const gmailLabel = await createGmailLabel(client.id, name.trim());

      // Persist to DB
      const { data: saved, error: saveErr } = await db
        .from('labels')
        .insert({
          client_id:      client.id,
          gmail_label_id: gmailLabel.id,
          name:           gmailLabel.name,
        })
        .select()
        .single();

      if (saveErr) throw new Error(saveErr.message);
      return res.status(201).json({ label: saved });
    } catch (err) {
      console.error('[labels] Create failed:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
