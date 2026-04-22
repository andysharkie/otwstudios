// api/auth/logout.js — Clear session cookie
import { getSessionToken, clearSessionCookie } from '../../lib/session.js';
import { getDb } from '../../lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = getSessionToken(req);
  if (token) {
    // Delete session from DB
    const db = getDb();
    await db.from('sessions').delete().eq('id', token);
  }

  res.setHeader('Set-Cookie', clearSessionCookie());
  return res.status(200).json({ ok: true });
}
