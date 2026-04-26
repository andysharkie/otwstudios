/**
 * OTW Receptionist â Automated Onboarding Endpoint
 * Vercel Serverless Function: /api/onboard
 *
 * Flow:
 *  1. Tally.so form submits â this endpoint via webhook
 *  2. Validate webhook signature
 *  3. Parse client data from Tally fields
 *  4. Generate personalised system prompt
 *  5. Create Retell LLM via API
 *  6. Create Retell Agent via API (with LLM attached)
 *  7. Insert client record into Supabase
 *  8. Send personalised welcome email to client
 *  9. Notify Andy
 *
 * Environment variables required (add to Vercel):
 *   RETELL_API_KEY       â from Retell dashboard â Settings â API Keys
 *   SUPABASE_URL         â already in Vercel â
 *   SUPABASE_SERVICE_KEY â already in Vercel â
 *   RESEND_API_KEY       â from resend.com (free, takes 2 min to set up)
 *   OTW_FROM_EMAIL       â andy@otwstudios.com.au
 *   TALLY_SIGNING_SECRET â from Tally form webhook settings (optional but recommended)
 */

import crypto from "crypto";

// âââ FIELD MAP ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Maps Tally question labels to clean field names.
// When Tally sends a webhook, fields are an array of { label, value } objects.
function parseTallyFields(fields) {
  const map = {};
  for (const field of fields) {
    const key = field.label?.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/_+$/, "");
    map[key] = Array.isArray(field.value)
      ? field.value.join(", ")
      : field.value ?? "";
  }

  // Normalise to expected field names
  return {
    business_name:       get(map, "business_name", "what_s_your_business_name", "business"),
    owner_first_name:    get(map, "owner_first_name", "your_first_name", "first_name"),
    owner_email:         get(map, "owner_email", "your_email_address", "email"),
    owner_mobile:        get(map, "owner_mobile", "your_mobile_number", "mobile"),
    trade_type:          get(map, "trade_type", "what_s_your_trade", "trade"),
    state:               get(map, "state", "which_state_are_you_in"),
    service_area:        get(map, "service_area", "what_areas_do_you_service"),
    business_hours:      get(map, "business_hours", "what_are_your_standard_business_hours"),
    after_hours:         get(map, "after_hours", "do_you_accept_after_hours_or_emergency_calls"),
    services_offered:    get(map, "services_offered", "what_services_do_you_offer"),
    services_not_offered:get(map, "services_not_offered", "anything_you_don_t_do"),
    pricing_policy:      get(map, "pricing_policy", "how_do_you_handle_pricing_enquiries"),
    free_quotes:         get(map, "free_quotes", "do_you_offer_free_quotes"),
    urgency_keywords:    get(map, "urgency_keywords", "what_counts_as_an_emergency"),
    emergency_number:    get(map, "emergency_number", "emergency_callback_number"),
    callback_window:     get(map, "callback_window", "how_quickly_will_you_call_customers_back"),
    agent_name:          get(map, "agent_name", "what_name_should_your_ai_receptionist_use"),
    custom_notes:        get(map, "custom_notes", "anything_specific_the_ai_should_mention"),
    notification_email:  get(map, "notification_email", "where_should_lead_notifications_be_sent"),
  };
}

function get(map, ...keys) {
  for (const k of keys) {
    if (map[k] !== undefined && map[k] !== "") return map[k];
  }
  return "";
}

// âââ SYSTEM PROMPT GENERATOR âââââââââââââââââââââââââââââââââââââââââââââââââ
function generateSystemPrompt(d) {
  return `You are ${d.agent_name || "the receptionist"}, the AI receptionist for ${d.business_name}, a ${d.trade_type} business servicing ${d.service_area}, ${d.state}.

Your job is to answer every call professionally, capture the caller's full details, understand their problem, and assure them that ${d.owner_first_name} will be in touch shortly.

---

## BUSINESS DETAILS
- Business name: ${d.business_name}
- Trade: ${d.trade_type}
- Service area: ${d.service_area}, ${d.state}
- Business hours: ${d.business_hours}
- After-hours availability: ${d.after_hours}
- Callback commitment: ${d.callback_window}

---

## YOUR CALL FLOW

Every call follows this sequence:

1. GREET â "Hi, you've reached ${d.business_name}. I'm ${d.agent_name || "the receptionist"}, how can I help you today?"
2. LISTEN â Understand what they need
3. COLLECT â Get their full name, best callback number, address or suburb, description of the issue, and urgency level
4. FAQ â Answer any questions using the information below
5. CONFIRM â "Perfect, I've got all your details. ${d.owner_first_name} will be in touch ${d.callback_window}. Is there anything else I can help with?"
6. CLOSE â "Thanks for calling ${d.business_name}. Have a great day!"

Always collect ALL four details before ending the call: name, phone, location, and issue description.

---

## SERVICES OFFERED
${d.services_offered || "Full range of " + d.trade_type + " services"}

${d.services_not_offered ? `## SERVICES NOT OFFERED\n${d.services_not_offered}\n\nIf asked about something not listed above, say: "That's not something we typically cover, but I can pass your details on and ${d.owner_first_name} can give you a definitive answer."` : ""}

---

## PRICING
${d.pricing_policy || "We provide quotes after assessing the job."}

Free quotes: ${d.free_quotes || "Contact us to discuss"}

Never quote specific dollar amounts beyond what's in the pricing policy above. If pushed, say: "I can't give exact pricing over the phone, but ${d.owner_first_name} will give you a clear quote when he calls back."

---

## EMERGENCY PROTOCOL
If the caller mentions ANY of the following: ${d.urgency_keywords || "flooding, gas leak, burst pipe, no power, emergency"}

Immediately respond with:
"That sounds urgent â I'm flagging this as a priority right now. ${d.owner_first_name} will call you back within 15 minutes. Can I get your name, number, and address so he can reach you straight away?"

Collect their details immediately. Urgency overrides everything else.

---

## FREQUENTLY ASKED QUESTIONS

Q: Do you service [area/suburb]?
A: We service ${d.service_area}. If unsure, say: "I'm not 100% sure â let me take your details and ${d.owner_first_name} can confirm when he calls."

Q: How much does it cost?
A: ${d.pricing_policy || "We'll provide a clear quote after assessing the job."}

Q: Do you offer free quotes?
A: ${d.free_quotes || "Contact us to discuss your specific situation."}

Q: Are you available now / today?
A: "I can't confirm exact availability right now, but ${d.owner_first_name} will call you back ${d.callback_window} to lock in a time."

Q: Are you licensed/insured?
A: "Yes, ${d.business_name} is fully licensed and insured."

---

${d.custom_notes ? `## ADDITIONAL BUSINESS INFO\n${d.custom_notes}\n\n---\n` : ""}

## TONE & LANGUAGE
- Natural Australian English â friendly, warm, confident
- Not robotic. Not overly formal. Speak like a professional who is also a real person.
- Use "no worries" or "absolutely" occasionally â don't overdo it
- Never say "I am an AI" or "I am a language model" unless directly asked
- If asked whether you're an AI: "I'm an AI receptionist â I make sure every call is answered and ${d.owner_first_name} gets all the details he needs."

## WHAT YOU NEVER DO
- Never commit to a specific arrival time (only callback windows)
- Never discuss competitor businesses
- Never take credit card or payment details
- Never make up information â if unsure, take caller details and say the owner will follow up
`.trim();
}

// âââ WELCOME EMAIL HTML âââââââââââââââââââââââââââââââââââââââââââââââââââââââ
function generateWelcomeEmail(d, agentId) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8">
<style>
  body{font-family:-apple-system,'Inter',Arial,sans-serif;background:#F2F5FA;margin:0;padding:32px 16px}
  .card{background:#fff;border-radius:16px;max-width:560px;margin:0 auto;overflow:hidden;border:1px solid rgba(0,0,0,.07)}
  .hdr{background:#04080F;padding:32px;text-align:center}
  .dot{width:10px;height:10px;background:#F59E0B;border-radius:50%;display:inline-block;margin-right:8px}
  .brand{color:#fff;font-size:18px;font-weight:800}
  .body{padding:32px}
  h1{font-size:24px;font-weight:800;color:#0F172A;margin:0 0 8px}
  p{font-size:14px;color:rgba(15,23,42,.65);line-height:1.7;margin:0 0 16px}
  .box{background:#F2F5FA;border-radius:12px;padding:20px;margin:20px 0}
  .row{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid rgba(0,0,0,.06);font-size:13px}
  .row:last-child{border:none}
  .lbl{color:rgba(15,23,42,.45);font-weight:500}
  .val{color:#0F172A;font-weight:600;text-align:right}
  .step{display:flex;gap:12px;margin-bottom:16px;align-items:flex-start}
  .num{width:28px;height:28px;border-radius:50%;background:#F59E0B;color:#04080F;font-size:12px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0}
  .stxt{font-size:13px;color:rgba(15,23,42,.65);line-height:1.6;padding-top:3px}
  .stxt strong{color:#0F172A}
  .cta{background:#F59E0B;color:#04080F;font-weight:800;font-size:14px;text-decoration:none;border-radius:50px;padding:13px 28px;display:inline-block;margin:8px 0 24px}
  .foot{background:#F2F5FA;padding:20px 32px;text-align:center;font-size:11px;color:rgba(15,23,42,.35)}
</style>
</head>
<body>
<div class="card">
  <div class="hdr"><div><span class="dot"></span><span class="brand">OTW Studios</span></div></div>
  <div class="body">
    <h1>You're live, ${d.owner_first_name} ð</h1>
    <p>Your OTW AI Receptionist <strong>${d.agent_name}</strong> is set up and ready to answer calls for <strong>${d.business_name}</strong>. From here, every missed call gets captured â 24/7.</p>
    <div class="box">
      <div class="row"><span class="lbl">AI Receptionist Name</span><span class="val">${d.agent_name}</span></div>
      <div class="row"><span class="lbl">Business</span><span class="val">${d.business_name}</span></div>
      <div class="row"><span class="lbl">Service Area</span><span class="val">${d.service_area}, ${d.state}</span></div>
      <div class="row"><span class="lbl">Lead Notifications</span><span class="val">${d.notification_email || d.owner_email}</span></div>
      <div class="row"><span class="lbl">Emergency Contact</span><span class="val">${d.emergency_number || d.owner_mobile}</span></div>
      <div class="row"><span class="lbl">Callback Window</span><span class="val">${d.callback_window}</span></div>
    </div>
    <p style="font-weight:600;color:#0F172A;margin-bottom:8px;">What happens next:</p>
    <div class="step"><div class="num">1</div><div class="stxt"><strong>Andy will be in touch within 24 hours</strong> to set up call forwarding on your number â takes 30 seconds, we walk you through it.</div></div>
    <div class="step"><div class="num">2</div><div class="stxt"><strong>Run a test call.</strong> Once forwarding is on, call your own number and let it ring through to ${d.agent_name}. Introduce yourself as a customer with a job â see how it handles it.</div></div>
    <div class="step"><div class="num">3</div><div class="stxt"><strong>Every lead arrives in your inbox.</strong> After each call, you'll receive a summary to ${d.notification_email || d.owner_email} â caller name, number, suburb, issue, and urgency. Ready to action.</div></div>
    <p>Questions or changes? Reply to this email â Andy responds same day.</p>
    <a href="https://otwstudios.com.au" class="cta">Visit OTW Studios</a>
    <p style="font-size:12px;color:rgba(15,23,42,.35);">Your 30-day free trial starts today. We'll check in before it ends to make sure everything is working exactly as you need it.</p>
  </div>
  <div class="foot">Powered by OTW Studios Â· Perth, WA Â· <a href="https://otwstudios.com.au/otw_privacy.html" style="color:inherit">Privacy</a></div>
</div>
</body>
</html>`;
}

// âââ MAIN HANDLER âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ââ 1. Verify Tally webhook signature (optional but recommended) âââââââââââââ
  const signingSecret = process.env.TALLY_SIGNING_SECRET;
  if (signingSecret) {
    const tallySignature = req.headers["tally-signature"];
    if (!tallySignature) {
      return res.status(401).json({ error: "Missing Tally signature" });
    }
    const computedSig = crypto
      .createHmac("sha256", signingSecret)
      .update(JSON.stringify(req.body))
      .digest("base64");
    if (computedSig !== tallySignature) {
      return res.status(401).json({ error: "Invalid Tally signature" });
    }
  }

  // ââ 2. Parse Tally payload âââââââââââââââââââââââââââââââââââââââââââââââââââ
  const payload = req.body;
  const fields = payload?.data?.fields ?? [];
  const d = parseTallyFields(fields);

  if (!d.business_name || !d.owner_email) {
    return res.status(400).json({ error: "Missing required fields: business_name, owner_email" });
  }

  const systemPrompt = generateSystemPrompt(d);
  let llmId, agentId;

  // ââ 3. Create Retell LLM âââââââââââââââââââââââââââââââââââââââââââââââââââââ
  try {
    const llmRes = await fetch("https://api.retellai.com/create-retell-llm", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.RETELL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        general_prompt: systemPrompt,
        begin_message: `Hi, you've reached ${d.business_name}. I'm ${d.agent_name || "your receptionist"}, how can I help you today?`,
        general_tools: [],
      }),
    });

    if (!llmRes.ok) {
      const err = await llmRes.text();
      throw new Error(`Retell LLM creation failed: ${llmRes.status} â ${err}`);
    }

    const llmData = await llmRes.json();
    llmId = llmData.llm_id;
  } catch (err) {
    console.error("[onboard] Retell LLM error:", err.message);
    await notifyAndyError(d, "Retell LLM creation failed", err.message);
    return res.status(502).json({ error: "Retell LLM creation failed", detail: err.message });
  }

  // ââ 4. Create Retell Agent âââââââââââââââââââââââââââââââââââââââââââââââââââ
  try {
    const agentRes = await fetch("https://api.retellai.com/v2/create-agent", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.RETELL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agent_name: `${d.business_name} â OTW Receptionist`,
        response_engine: {
          type: "retell-llm",
          llm_id: llmId,
        },
        voice_id: "11labs-Adrian",
        language: "en-AU",
        enable_backchannel: true,
        backchannel_frequency: 0.8,
        interruption_sensitivity: 0.8,
        normalize_for_speech: true,
        end_call_after_silence_ms: 600000,
        max_call_duration_ms: 3600000,
        post_call_analysis_data: [
          { name: "caller_name",    description: "Full name of the caller",           type: "string" },
          { name: "caller_phone",   description: "Caller's callback phone number",    type: "string" },
          { name: "caller_address", description: "Caller's address or suburb",        type: "string" },
          { name: "issue",          description: "Description of the job or issue",   type: "string" },
          { name: "urgency",        description: "Urgency: LOW, MEDIUM, or HIGH",     type: "enum", choices: ["LOW","MEDIUM","HIGH"] },
        ],
      }),
    });

    if (!agentRes.ok) {
      const err = await agentRes.text();
      throw new Error(`Retell Agent creation failed: ${agentRes.status} â ${err}`);
    }

    const agentData = await agentRes.json();
    agentId = agentData.agent_id;
  } catch (err) {
    console.error("[onboard] Retell Agent error:", err.message);
    await notifyAndyError(d, "Retell Agent creation failed", err.message);
    return res.status(502).json({ error: "Retell Agent creation failed", detail: err.message });
  }

  // ââ 5. Save to Supabase ââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  try {
    const sbRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/receptionist_clients`, {
      method: "POST",
      headers: {
        "apikey": process.env.SUPABASE_SERVICE_KEY,
        "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
      },
      body: JSON.stringify({
        business_name:        d.business_name,
        owner_first_name:     d.owner_first_name,
        owner_email:          d.owner_email,
        owner_mobile:         d.owner_mobile,
        trade_type:           d.trade_type,
        state:                d.state,
        service_area:         d.service_area,
        business_hours:       d.business_hours,
        after_hours:          d.after_hours,
        services_offered:     d.services_offered,
        services_not_offered: d.services_not_offered,
        pricing_policy:       d.pricing_policy,
        free_quotes:          d.free_quotes,
        urgency_keywords:     d.urgency_keywords,
        emergency_number:     d.emergency_number || d.owner_mobile,
        callback_window:      d.callback_window,
        agent_name:           d.agent_name,
        custom_notes:         d.custom_notes,
        notification_email:   d.notification_email || d.owner_email,
        retell_llm_id:        llmId,
        retell_agent_id:      agentId,
        plan:                 "pro",
        status:               "active",
        onboarded_at:         new Date().toISOString(),
      }),
    });

    if (!sbRes.ok) {
      const err = await sbRes.text();
      console.error("[onboard] Supabase insert error:", err);
      // Don't fail the whole flow â agent is live, just log
    }
  } catch (err) {
    console.error("[onboard] Supabase error:", err.message);
    // Non-fatal â continue to email
  }

  // ââ 6. Send welcome email to client âââââââââââââââââââââââââââââââââââââââââ
  try {
    await sendEmail({
      to: d.owner_email,
      subject: `You're live, ${d.owner_first_name} â Your OTW AI Receptionist is ready ð`,
      html: generateWelcomeEmail(d, agentId),
    });
  } catch (err) {
    console.error("[onboard] Welcome email error:", err.message);
  }

  // ââ 7. Notify Andy âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  try {
    await sendEmail({
      to: process.env.OTW_FROM_EMAIL || "andy@otwstudios.com.au",
      subject: `ð New client onboarded â ${d.business_name}`,
      html: `
        <h2>New OTW client is live</h2>
        <table>
          <tr><td><b>Business</b></td><td>${d.business_name}</td></tr>
          <tr><td><b>Owner</b></td><td>${d.owner_first_name}</td></tr>
          <tr><td><b>Email</b></td><td>${d.owner_email}</td></tr>
          <tr><td><b>Mobile</b></td><td>${d.owner_mobile}</td></tr>
          <tr><td><b>Trade</b></td><td>${d.trade_type} â ${d.state}</td></tr>
          <tr><td><b>Service Area</b></td><td>${d.service_area}</td></tr>
          <tr><td><b>Agent Name</b></td><td>${d.agent_name}</td></tr>
          <tr><td><b>Retell Agent ID</b></td><td><code>${agentId}</code></td></tr>
          <tr><td><b>Retell LLM ID</b></td><td><code>${llmId}</code></td></tr>
        </table>
        <p><b>Next:</b> Set up call forwarding with the client. Run a test call. Check agent in Retell dashboard.</p>
      `,
    });
  } catch (err) {
    console.error("[onboard] Andy notification error:", err.message);
  }

  return res.status(200).json({
    success: true,
    agent_id: agentId,
    llm_id: llmId,
    business: d.business_name,
  });
}

// âââ EMAIL SENDER (Resend API) ââââââââââââââââââââââââââââââââââââââââââââââââ
async function sendEmail({ to, subject, html }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `OTW Studios <${process.env.OTW_FROM_EMAIL || "andy@otwstudios.com.au"}>`,
      to: [to],
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error: ${res.status} â ${err}`);
  }

  return res.json();
}

// âââ ERROR NOTIFIER âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
async function notifyAndyError(d, stage, detail) {
  try {
    await sendEmail({
      to: process.env.OTW_FROM_EMAIL || "andy@otwstudios.com.au",
      subject: `â ï¸ Onboarding failed â ${d.business_name || "unknown client"}`,
      html: `
        <h2>Onboarding pipeline error</h2>
        <p><b>Stage:</b> ${stage}</p>
        <p><b>Client:</b> ${d.business_name} â ${d.owner_email}</p>
        <p><b>Error:</b> ${detail}</p>
        <p>All form data was captured. Manual setup required.</p>
        <pre>${JSON.stringify(d, null, 2)}</pre>
      `,
    });
  } catch (_) {
    // Ignore email errors in error handler
  }
}
