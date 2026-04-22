// lib/session.js — Cookie-based session helpers
import { getDb } from './db.js';

const COOKIE_NAME  = 'otw_session';
const COOKIE_MAX   = 60 * 60 * 24 * 30; // 30 days in seconds

/** Parse cookies from a request header string */
export function parseCookies(cookieHeader = '') {
  return Object.fromEntries(
    cookieHeader.split(';')
      .map(c => c.trim().split('='))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k.trim(), decodeURIComponent(v.join('=').trim())])
  );
}

/** Get the session token from the request */
export function getSessionToken(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return cookies[COOKIE_NAME] || null;
}

/** Look up a session token → client record. Returns null if invalid/expired. */
export async function getSession(req) {
  const token = getSessionToken(req);
  if (!token) return null;

  const db = getDb();
  const { data, error } = await db
    .from('sessions')
    .select('id, client_id, expires_at')
    .eq('id', token)
    .gt('expires_at', new Date().toISOString())
    .single();

  if (error || !data) return null;

  // Fetch the client
  const { data: client } = await db
    .from('clients')
    .select('id, gmail_email')
    .eq('id', data.client_id)
    .single();

  return client || null;
}

/** Create a new session for a client_id, returns the session UUID */
export async function createSession(clientId) {
  const db = getDb();
  const { data, error } = await db
    .from('sessions')
    .insert({ client_id: clientId })
    .select('id')
    .single();

  if (error) throw new Error('Failed to create session: ' + error.message);
  return data.id;
}

/** Build a Set-Cookie header string that stores the session token */
export function buildSessionCookie(sessionId) {
  const parts = [
    `${COOKIE_NAME}=${sessionId}`,
    `Max-Age=${COOKIE_MAX}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  // Add Secure flag in production
  if (process.env.NODE_ENV !== 'development') {
    parts.push('Secure');
  }
  return parts.join('; ');
}

/** Build a cookie header that clears the session */
export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`;
}
