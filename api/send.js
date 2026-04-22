// api/send.js — Approve and send a drafted reply via Gmail
import { getSession } from '../lib/session.js';
import { getDb } from '../lib/db.js';
import { sendReply, markAsRead } from '../lib/gmail.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const client = await getSession(req);
  if (!client) return res.status(401).json({ error: 'Not authenticated' });

  const { email_cache_id, draft_text } = req.body;

  if (!email_cache_id || !draft_text) {
    return res.status(400).json({ error: 'Missing email_cache_id or draft_text' });
  }

  const db = getDb();

  // Load the cached email
  const { data: email, error: fetchErr } = await db
    .from('email_cache')
    .select('*')
    .eq('id', email_cache_id)
    .eq('client_id', client.id)  // Security: ensure it belongs to this client
    .single();

  if (fetchErr || !email) {
    return res.status(404).json({ error: 'Email not found' });
  }

  if (email.approved) {
    return res.status(409).json({ error: 'Email already sent' });
  }

  try {
    // Send the reply via Gmail API
    await sendReply({
      clientId:          client.id,
      toEmail:           email.from_email,
      toName:            email.from_name,
      subject:           email.subject,
      replyText:         draft_text,
      threadId:          email.thread_id,
      originalMessageId: email.gmail_message_id,
    });

    // Mark as read in Gmail
    await markAsRead(client.id, email.gmail_message_id);

    // Update cache — mark as approved
    const now = new Date().toISOString();
    await db.from('email_cache').update({
      approved: true,
      sent_at:  now,
      draft:    draft_text,  // Save the (possibly edited) final draft
    }).eq('id', email_cache_id);

    return res.status(200).json({ ok: true, sent_at: now });
  } catch (err) {
    console.error('[send] Failed:', err.message);
    return res.status(500).json({ error: 'Failed to send email', details: err.message });
  }
}
