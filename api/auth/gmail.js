// api/auth/gmail.js — Redirect to Google OAuth
import { getAuthUrl } from '../../lib/gmail.js';
import crypto from 'crypto';

export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Generate a random state value for CSRF protection
  const state = crypto.randomBytes(16).toString('hex');

  // Store state in a short-lived cookie for verification in callback
  res.setHeader('Set-Cookie', [
    `otw_oauth_state=${state}; Max-Age=600; Path=/; HttpOnly; SameSite=Lax${process.env.NODE_ENV !== 'development' ? '; Secure' : ''}`,
  ]);

  const url = getAuthUrl(state);
  res.redirect(302, url);
}
