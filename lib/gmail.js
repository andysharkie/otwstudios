// lib/gmail.js — Gmail API helpers (OAuth token management + email fetch + send)
import { google } from 'googleapis';
import { getDb } from './db.js';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
];

/** Build a configured OAuth2 client */
export function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

/** Generate the OAuth authorisation URL */
export function getAuthUrl(state) {
  const oauth2 = getOAuth2Client();
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',       // force refresh token on every auth
    scope: SCOPES,
    state,
  });
}

/** Exchange an auth code for tokens and return { access_token, refresh_token, expiry_date, email } */
export async function exchangeCode(code) {
  const oauth2 = getOAuth2Client();
  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);

  // Get the email address of the authenticated user
  const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2 });
  const { data } = await oauth2Api.userinfo.get();

  return { ...tokens, email: data.email };
}

/** Load stored tokens for a client, refresh if needed, return an authenticated OAuth2 client */
export async function getAuthedClient(clientId) {
  const db = getDb();
  const { data, error } = await db
    .from('gmail_tokens')
    .select('access_token, refresh_token, expiry_date')
    .eq('client_id', clientId)
    .single();

  if (error || !data) throw new Error('No Gmail tokens found for client');

  const oauth2 = getOAuth2Client();
  oauth2.setCredentials({
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expiry_date:   data.expiry_date,
  });

  // Auto-refresh if the token is expired or close to expiry (< 5 min)
  const bufferMs = 5 * 60 * 1000;
  if (data.expiry_date && Date.now() > data.expiry_date - bufferMs) {
    const { credentials } = await oauth2.refreshAccessToken();
    oauth2.setCredentials(credentials);

    // Persist the new token
    await db.from('gmail_tokens').upsert({
      client_id:     clientId,
      access_token:  credentials.access_token,
      refresh_token: credentials.refresh_token || data.refresh_token,
      expiry_date:   credentials.expiry_date,
      updated_at:    new Date().toISOString(),
    });
  }

  return oauth2;
}

/** Decode a base64url-encoded Gmail message part */
function decodeBase64(encoded) {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

/** Recursively extract plain text body from a Gmail message payload */
function extractBody(payload) {
  if (!payload) return '';

  // Direct body
  if (payload.body?.data) {
    return decodeBase64(payload.body.data);
  }

  // Multipart — prefer text/plain
  if (payload.parts) {
    const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
    if (textPart?.body?.data) return decodeBase64(textPart.body.data);

    // Recurse into nested parts
    for (const part of payload.parts) {
      const text = extractBody(part);
      if (text) return text;
    }
  }

  return '';
}

/** Get a header value from a list of Gmail message headers */
function getHeader(headers, name) {
  return headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

/** Parse a "From" header like "Jane Smith <jane@email.com>" */
function parseFrom(fromHeader) {
  const match = fromHeader.match(/^(.*?)\s*<(.+?)>$/);
  if (match) return { name: match[1].trim().replace(/^"|"$/g, ''), email: match[2].trim() };
  return { name: fromHeader, email: fromHeader };
}

/**
 * Fetch the most recent unread emails for a client (max 30).
 * Returns an array of structured email objects.
 */
export async function fetchEmails(clientId, maxResults = 30) {
  const auth   = await getAuthedClient(clientId);
  const gmail  = google.gmail({ version: 'v1', auth });

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: 'is:unread in:inbox',
    maxResults,
  });

  const messages = listRes.data.messages || [];

  const emails = await Promise.all(
    messages.map(async ({ id, threadId }) => {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'full',
      });

      const headers = msg.data.payload?.headers || [];
      const from    = parseFrom(getHeader(headers, 'from'));
      const subject = getHeader(headers, 'subject');
      const date    = getHeader(headers, 'date');
      const body    = extractBody(msg.data.payload);

      return {
        gmail_message_id: id,
        thread_id:        threadId,
        from_name:        from.name,
        from_email:       from.email,
        subject:          subject || '(no subject)',
        body:             body.trim(),
        snippet:          msg.data.snippet || '',
        received_at:      date ? new Date(date).toISOString() : new Date().toISOString(),
      };
    })
  );

  return emails;
}

/**
 * Send a reply to an email thread via Gmail.
 * messageId and threadId come from the original email.
 */
export async function sendReply({ clientId, toEmail, toName, subject, replyText, threadId, originalMessageId }) {
  const auth  = await getAuthedClient(clientId);
  const gmail = google.gmail({ version: 'v1', auth });

  // Get sender's email address
  const profile  = await gmail.users.getProfile({ userId: 'me' });
  const fromEmail = profile.data.emailAddress;

  // Build RFC 2822 message
  const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;
  const rawMessage = [
    `From: ${fromEmail}`,
    `To: ${toName ? `${toName} <${toEmail}>` : toEmail}`,
    `Subject: ${replySubject}`,
    `In-Reply-To: ${originalMessageId}`,
    `References: ${originalMessageId}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    '',
    replyText,
  ].join('\r\n');

  const encoded = Buffer.from(rawMessage)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: encoded,
      threadId,
    },
  });

  return res.data.id;
}

/**
 * Mark a Gmail message as read
 */
export async function markAsRead(clientId, messageId) {
  const auth  = await getAuthedClient(clientId);
  const gmail = google.gmail({ version: 'v1', auth });

  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { removeLabelIds: ['UNREAD'] },
  });
}
