// api/auth/me.js — Return the currently authenticated client (or 401)
import { getSession } from '../../lib/session.js';
import { getDb } from '../../lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const client = await getSession(req);
  if (!client) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  // Fetch business profile
  const db = getDb();
  const { data: profileRow } = await db
    .from('business_profiles')
    .select('profile')
    .eq('client_id', client.id)
    .single();

  return res.status(200).json({
    client_id:   client.id,
    gmail_email: client.gmail_email,
    profile:     profileRow?.profile || {},
  });
}
