// api/integrations/sms.js
// Sends an SMS confirmation to the caller after a job is booked via OTW Receptionist.
// Uses Twilio — we're already paying for it for phone numbers.
//
// Called from the post-call Make.com webhook alongside the work order email.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Webhook auth
  const authHeader = req.headers['x-otw-webhook-secret'];
  if (authHeader !== process.env.OTW_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  const {
    to_phone,         // caller's mobile number (AU format: 04XX XXX XXX)
    business_name,    // client's business name
    caller_name,      // caller's first name
    job_type,         // brief job description
    urgency,          // 'emergency' | 'urgent' | 'routine'
    sms_type,         // 'confirmation' | 'callback' | 'emergency_ack'
    from_number,      // Twilio number (client's OTW number)
  } = req.body;

  if (!to_phone || !business_name) {
    return res.status(400).json({ error: 'Missing to_phone or business_name' });
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = from_number || process.env.TWILIO_DEFAULT_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    return res.status(500).json({ error: 'Twilio credentials not configured' });
  }

  // ── Build the SMS message ──────────────────────────────────────────────────
  const firstName = (caller_name || '').split(' ')[0] || 'there';
  let message;

  if (sms_type === 'emergency_ack') {
    message = `Hi ${firstName}, we've received your emergency call and are responding now. ${business_name} will be in touch within minutes. Save this number.`;
  } else if (urgency === 'urgent' || sms_type === 'callback') {
    message = `Hi ${firstName}, thanks for calling ${business_name}. We've noted your enquiry and will call you back within 2 hours. Reply STOP to opt out.`;
  } else {
    // Routine booking confirmation
    const jobLine = job_type ? ` re: ${job_type}` : '';
    message = `Hi ${firstName}, thanks for calling ${business_name}. We've received your enquiry${jobLine} and will be in touch shortly to confirm your booking. Reply STOP to opt out.`;
  }

  // ── Send via Twilio REST API ───────────────────────────────────────────────
  try {
    const toNormalized = normaliseAuPhone(to_phone);
    if (!toNormalized) {
      return res.status(400).json({ error: 'Invalid Australian phone number', phone: to_phone });
    }

    const formData = new URLSearchParams({
      To:   toNormalized,
      From: fromNumber,
      Body: message,
    });

    const twilioRes = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString(),
      }
    );

    const data = await twilioRes.json();

    if (!twilioRes.ok) {
      console.error('[SMS] Twilio error:', data);
      return res.status(502).json({ error: 'Twilio send failed', details: data });
    }

    return res.status(200).json({ ok: true, message_sid: data.sid, to: toNormalized });

  } catch (err) {
    console.error('[SMS] Request failed:', err.message);
    return res.status(500).json({ error: 'SMS send failed', details: err.message });
  }
}

/**
 * Normalise an Australian mobile number to E.164 format (+61XXXXXXXXX).
 * Returns null if not a valid AU mobile.
 */
function normaliseAuPhone(raw) {
  const digits = raw.replace(/\D/g, '');

  // Already E.164: +61412345678
  if (digits.startsWith('61') && digits.length === 11) {
    return '+' + digits;
  }

  // Australian mobile: 04XXXXXXXX (10 digits)
  if (digits.startsWith('04') && digits.length === 10) {
    return '+61' + digits.slice(1);
  }

  // Allow landlines too (02/03/07/08): +61XXXXXXXXX
  if (/^0[2378]/.test(digits) && digits.length === 10) {
    return '+61' + digits.slice(1);
  }

  return null;
}
