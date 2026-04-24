// api/email-labels.js â Apply / remove labels on a cached email (syncs to Gmail)
import { getSession } from '../lib/session.js';
import { getDb } from '../lib/db.js';
import { applyLabelToMessage, removeLabelFromMessage } from '../lib/gmail.js';

export default async function handler(req, res) {
  const client = await getSession(req);
  if (!client) return res.status(401).json({ error: 'Not authenticated' });

  const db = getDb();

  // ââ GET /api/email-labels?email_cache_id=X ââââââââââââââââââââââââââââ
  if (req.method === 'GET') {
    const { email_cache_id } = req.query;
    if (!email_cache_id) return res.status(400).json({ error: 'Missing email_cache_id' });

    const { data, error } = await db
      .from('email_labels')
      .select('label_id, labels(id, name, gmail_label_id, color)')
      .eq('email_cache_id', email_cache_id);

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ labels: (data || []).map(r => r.labels).filter(Boolean) });
  }

  // ââ POST /api/email-labels ââ apply a label âââââââââââââââââââââââââââ
  if (req.method === 'POST') {
    const { email_cache_id, label_id } = req.body || {};
    if (!email_cache_id || !label_id) {
      return res.status(400).json({ error: 'Missing email_cache_id or label_id' });
    }

    // Verify ownership + fetch gmail IDs
    const [emailRes, labelRes] = await Promise.all([
      db.from('email_cache')
        .select('gmail_message_id')
        .eq('id', email_cache_id)
        .eq('client_id', client.id)
        .single(),
      db.from('labels')
        .select('gmail_label_id')
        .eq('id', label_id)
        .eq('client_id', client.id)
        .single(),
    ]);

    if (!emailRes.data || !labelRes.data) {
      return res.status(404).json({ error: 'Email or label not found' });
    }

    try {
      // Apply in Gmail
      await applyLabelToMessage(
        client.id,
        emailRes.data.gmail_message_id,
        labelRes.data.gmail_label_id
      );

      // Save link in DB (upsert â idempotent)
      await db.from('email_labels').upsert({
        email_cache_id,
        label_id,
        added_at: new Date().toISOString(),
      }, { onConflict: 'email_cache_id,label_id' });

      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('[email-labels] Apply failed:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ââ DELETE /api/email-labels ââ remove a label ââââââââââââââââââââââââ
  if (req.method === 'DELETE') {
    const { email_cache_id, label_id } = req.body || {};
    if (!email_cache_id || !label_id) {
      return res.status(400).json({ error: 'Missing email_cache_id or label_id' });
    }

    const [emailRes, labelRes] = await Promise.all([
      db.from('email_cache')
        .select('gmail_message_id')
        .eq('id', email_cache_id)
        .eq('client_id', client.id)
        .single(),
      db.from('labels')
        .select('gmail_label_id')
        .eq('id', label_id)
        .eq('client_id', client.id)
        .single(),
    ]);

    if (!emailRes.data || !labelRes.data) {
      return res.status(404).json({ error: 'Email or label not found' });
    }

    try {
      // Remove from Gmail
      await removeLabelFromMessage(
        client.id,
        emailRes.data.gmail_message_id,
        labelRes.data.gmail_label_id
      );

      // Remove from DB
      await db.from('email_labels')
        .delete()
        .eq('email_cache_id', email_cache_id)
        .eq('label_id', label_id);

      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('[email-labels] Remove failed:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
