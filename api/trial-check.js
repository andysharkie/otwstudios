/**
 * OTW Receptionist — Trial Management Cron
 * Schedule: Daily at 8am AEST (22:00 UTC)
 *
 * Handles two events:
 *  1. 7-day reminder  — clients whose trial ends in exactly 7 days
 *  2. Trial expiry    — clients whose trial_end_date has passed
 *
 * Stripe is optional. If STRIPE_SECRET_KEY is set it generates a hosted
 * Checkout link so the client can add their card.  Without Stripe the
 * reminder email still goes out with a "reply to continue" CTA.
 */

export const config = { runtime: "edge" };

const RESEND_API_KEY      = process.env.RESEND_API_KEY;
const OTW_FROM_EMAIL      = process.env.OTW_FROM_EMAIL  || "andy@otwstudios.com.au";
const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_KEY        = process.env.SUPABASE_SERVICE_KEY;
const STRIPE_SECRET_KEY   = process.env.STRIPE_SECRET_KEY;
const STRIPE_PRO_PRICE_ID = process.env.STRIPE_PRO_PRICE_ID;
const CRON_SECRET         = process.env.CRON_SECRET;

// helpers

function sbFetch(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
}

async function sendEmail(to, subject, html) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: OTW_FROM_EMAIL, to, subject, html }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error("[trial-check] Resend error:", err);
  }
}

async function createStripeCheckoutLink(stripeCustomerId) {
  if (!STRIPE_SECRET_KEY || !STRIPE_PRO_PRICE_ID || !stripeCustomerId) return null;
  try {
    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        customer: stripeCustomerId,
        mode: "subscription",
        "line_items[0][price]": STRIPE_PRO_PRICE_ID,
        "line_items[0][quantity]": "1",
        success_url: "https://otwstudios.com.au/billing-confirmed",
        cancel_url: "https://otwstudios.com.au",
        "subscription_data[trial_end]": "now",
        payment_method_collection: "always",
      }),
    });
    if (!res.ok) {
      console.error("[trial-check] Stripe error:", await res.text());
      return null;
    }
    const data = await res.json();
    return data.url;
  } catch (e) {
    console.error("[trial-check] Stripe fetch error:", e.message);
    return null;
  }
}

// email templates

function reminderEmailHtml(client, checkoutUrl) {
  const endDate = new Date(client.trial_end_date).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });
  const ctaBlock = checkoutUrl
    ? `<a href="${checkoutUrl}" style="display:inline-block;background:#F59E0B;color:#fff;font-weight:700;padding:14px 32px;border-radius:8px;text-decoration:none;font-size:16px;">Activate My Subscription &rarr;</a>
       <p style="color:#6B7280;font-size:13px;margin-top:8px;">Click above to add your card. You won't be charged until your trial ends on ${endDate}.</p>`
    : `<p style="color:#374151;">To keep your AI receptionist running, reply to this email or contact us at <a href="mailto:andy@otwstudios.com.au">andy@otwstudios.com.au</a> to set up your subscription.</p>`;

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f3f4f6;font-family:Inter,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 0;">
  <tr><td align="center">
    <table width="580" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
      <tr><td style="background:#111827;padding:28px 40px;">
        <h1 style="margin:0;color:#F59E0B;font-size:22px;font-weight:800;letter-spacing:-0.5px;">OTW Studios</h1>
        <p style="margin:4px 0 0;color:#9CA3AF;font-size:13px;">AI Receptionist</p>
      </td></tr>
      <tr><td style="padding:36px 40px;">
        <h2 style="color:#111827;font-size:20px;margin:0 0 16px;">Your free trial ends in 7 days</h2>
        <p style="color:#374151;line-height:1.6;">Hi ${client.owner_first_name},</p>
        <p style="color:#374151;line-height:1.6;">
          Your <strong>${client.agent_name || "AI Receptionist"}</strong> has been answering calls for <strong>${client.business_name}</strong> and your 30-day free trial wraps up on
          <strong>${endDate}</strong>.
        </p>
        <p style="color:#374151;line-height:1.6;">
          To keep the calls flowing without interruption, activate your <strong>OTW Pro Plan</strong> — $497/mo for Founding Partners.
        </p>
        <div style="text-align:center;margin:32px 0;">
          ${ctaBlock}
        </div>
        <hr style="border:none;border-top:1px solid #E5E7EB;margin:28px 0;">
        <p style="color:#374151;line-height:1.6;font-size:14px;">
          <strong>What's included in Pro:</strong><br>
          Unlimited AI receptionist calls<br>
          Automated call summaries to your inbox<br>
          Retell AI + Twilio number included<br>
          Google Sheets client tracker<br>
          Priority support from OTW Studios
        </p>
        <p style="color:#6B7280;font-size:13px;line-height:1.6;">Questions? Just reply to this email — Andy will get back to you personally.</p>
      </td></tr>
      <tr><td style="background:#F9FAFB;padding:20px 40px;text-align:center;">
        <p style="color:#9CA3AF;font-size:12px;margin:0;">OTW Studios &middot; Melbourne, VIC &middot; <a href="https://otwstudios.com.au" style="color:#F59E0B;">otwstudios.com.au</a></p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function expiredEmailHtml(client) {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f3f4f6;font-family:Inter,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 0;">
  <tr><td align="center">
    <table width="580" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
      <tr><td style="background:#111827;padding:28px 40px;">
        <h1 style="margin:0;color:#F59E0B;font-size:22px;font-weight:800;letter-spacing:-0.5px;">OTW Studios</h1>
        <p style="margin:4px 0 0;color:#9CA3AF;font-size:13px;">AI Receptionist</p>
      </td></tr>
      <tr><td style="padding:36px 40px;">
        <h2 style="color:#111827;font-size:20px;margin:0 0 16px;">Your free trial has ended</h2>
        <p style="color:#374151;line-height:1.6;">Hi ${client.owner_first_name},</p>
        <p style="color:#374151;line-height:1.6;">
          Your 30-day free trial for <strong>${client.business_name}</strong> has now ended.
          Your AI receptionist has been paused.
        </p>
        <p style="color:#374151;line-height:1.6;">
          We'd love to keep working with you — reply to this email and we'll get your subscription sorted so your calls start flowing again straight away.
        </p>
        <div style="text-align:center;margin:32px 0;">
          <a href="mailto:andy@otwstudios.com.au?subject=Resume%20my%20OTW%20Receptionist%20-%20${encodeURIComponent(client.business_name)}"
             style="display:inline-block;background:#F59E0B;color:#fff;font-weight:700;padding:14px 32px;border-radius:8px;text-decoration:none;font-size:16px;">
            Get Back Online &rarr;
          </a>
        </div>
        <p style="color:#6B7280;font-size:13px;line-height:1.6;">OTW Studios &middot; <a href="https://otwstudios.com.au" style="color:#F59E0B;">otwstudios.com.au</a></p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

// main handler

export default async function handler(req) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const now = new Date();

  const d7 = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const d7Start = d7.toISOString().split("T")[0] + "T00:00:00";
  const d7End   = d7.toISOString().split("T")[0] + "T23:59:59";

  const todayMidnight = now.toISOString().split("T")[0] + "T00:00:00";

  const results = { reminders: 0, expired: 0, errors: [] };

  // 1. 7-day reminder
  const rRes = await sbFetch(
    `receptionist_clients?billing_status=eq.trial&trial_end_date=gte.${d7Start}&trial_end_date=lte.${d7End}&select=*`
  );
  const reminders = rRes.ok ? await rRes.json() : [];
  console.log(`[trial-check] Reminder candidates: ${reminders.length}`);

  for (const client of reminders) {
    try {
      const checkoutUrl = await createStripeCheckoutLink(client.stripe_customer_id);
      const html = reminderEmailHtml(client, checkoutUrl);
      await sendEmail(
        client.owner_email,
        `Your OTW AI Receptionist trial ends in 7 days — ${client.business_name}`,
        html
      );
      results.reminders++;
      console.log(`[trial-check] Reminder sent -> ${client.owner_email}`);
    } catch (e) {
      console.error(`[trial-check] Reminder error for ${client.id}:`, e.message);
      results.errors.push({ id: client.id, stage: "reminder", error: e.message });
    }
  }

  // 2. Trial expiry
  const eRes = await sbFetch(
    `receptionist_clients?billing_status=eq.trial&trial_end_date=lt.${todayMidnight}&select=*`
  );
  const expired = eRes.ok ? await eRes.json() : [];
  console.log(`[trial-check] Expired candidates: ${expired.length}`);

  for (const client of expired) {
    try {
      await sbFetch(`receptionist_clients?id=eq.${client.id}`, {
        method: "PATCH",
        body: JSON.stringify({ billing_status: "expired" }),
      });

      await sendEmail(
        client.owner_email,
        `Your OTW AI Receptionist trial has ended — ${client.business_name}`,
        expiredEmailHtml(client)
      );

      await sendEmail(
        OTW_FROM_EMAIL,
        `[OTW] Trial expired — ${client.business_name}`,
        `<p>Trial has expired for <strong>${client.business_name}</strong> (${client.owner_email}). Follow up to convert.</p>`
      );

      results.expired++;
      console.log(`[trial-check] Expired -> ${client.business_name}`);
    } catch (e) {
      console.error(`[trial-check] Expiry error for ${client.id}:`, e.message);
      results.errors.push({ id: client.id, stage: "expiry", error: e.message });
    }
  }

  console.log(`[trial-check] Done — reminders: ${results.reminders}, expired: ${results.expired}`);
  return new Response(JSON.stringify(results), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
