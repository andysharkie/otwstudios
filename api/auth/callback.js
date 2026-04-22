// api/auth/callback.js — Google OAuth callback: exchange code, store tokens, create session
import { exchangeCode } from '../../lib/gmail.js';
import { getDb } from '../../lib/db.js';
import { createSession, buildSessionCookie, parseCookies } from '../../lib/session.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { code, state, error } = req.query;

  // Handle user denial
  if (error) {
    return res.redirect(302, '/otw_triageai_app.html?error=access_denied');
  }

  if (!code) {
    return res.status(400).json({ error: 'Missing auth code' });
  }

  // Verify CSRF state
  const cookies = parseCookies(req.headers.cookie || '');
  const savedState = cookies['otw_oauth_state'];
  if (!savedState || savedState !== state) {
    return res.status(400).json({ error: 'Invalid OAuth state — possible CSRF' });
  }

  try {
    // Exchange code for tokens + get Gmail address
    const { access_token, refresh_token, expiry_date, email: gmailEmail } = await exchangeCode(code);

    const db = getDb();

    // Upsert client record (creates on first connect, updates on reconnect)
    const { data: client, error: clientError } = await db
      .from('clients')
      .upsert({ gmail_email: gmailEmail }, { onConflict: 'gmail_email' })
      .select('id')
      .single();

    if (clientError) throw clientError;

    // Store Gmail tokens
    await db.from('gmail_tokens').upsert({
      client_id:    client.id,
      access_token,
      refresh_token,
      expiry_date:  expiry_date || null,
      updated_at:   new Date().toISOString(),
    }, { onConflict: 'client_id' });

    // Ensure a default business profile exists (pre-populated with Gmail email)
    const { data: existingProfile } = await db
      .from('business_profiles')
      .select('client_id')
      .eq('client_id', client.id)
      .single();

    if (!existingProfile) {
      await db.from('business_profiles').insert({
        client_id: client.id,
        profile: {
          name: '',
          owner: '',
          phone: '',
          email: gmailEmail,
          services: '',
          hourlyRate: '',
          callOutFee: '',
          serviceArea: '',
          tone: '',
          signature: '',
        },
      });
    }

    // Create a session
    const sessionId = await createSession(client.id);
    const sessionCookie = buildSessionCookie(sessionId);

    // Clear the OAuth state cookie and set the session cookie
    res.setHeader('Set-Cookie', [
      sessionCookie,
      'otw_oauth_state=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax',
    ]);

    // Redirect back to the app
    res.redirect(302, '/otw_triageai_app.html?connected=1');
  } catch (err) {
    console.error('[OAuth Callback Error]', err);
    res.redirect(302, '/otw_triageai_app.html?error=auth_failed');
  }
}
