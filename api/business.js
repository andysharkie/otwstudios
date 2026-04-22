// api/business.js — GET and POST the client's business profile
import { getSession } from '../lib/session.js';
import { getDb } from '../lib/db.js';

export default async function handler(req, res) {
  const client = await getSession(req);
  if (!client) return res.status(401).json({ error: 'Not authenticated' });

  const db = getDb();

  // ── GET — return the current profile ─────────────────────────────────
  if (req.method === 'GET') {
    const { data, error } = await db
      .from('business_profiles')
      .select('profile')
      .eq('client_id', client.id)
      .single();

    if (error) return res.status(500).json({ error: 'Failed to fetch profile' });
    return res.status(200).json({ profile: data?.profile || {} });
  }

  // ── POST — save/update the profile ───────────────────────────────────
  if (req.method === 'POST') {
    const { profile } = req.body;
    if (!profile || typeof profile !== 'object') {
      return res.status(400).json({ error: 'Invalid profile data' });
    }

    // Sanitise — only allow known keys
    const allowed = ['name', 'owner', 'phone', 'email', 'services', 'hourlyRate', 'callOutFee', 'serviceArea', 'tone', 'signature'];
    const clean   = {};
    for (const key of allowed) {
      if (profile[key] !== undefined) clean[key] = String(profile[key]);
    }

    const { error } = await db.from('business_profiles').upsert({
      client_id:  client.id,
      profile:    clean,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'client_id' });

    if (error) return res.status(500).json({ error: 'Failed to save profile' });
    return res.status(200).json({ ok: true, profile: clean });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
