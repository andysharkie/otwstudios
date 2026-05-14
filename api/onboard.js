/**
 * OTW Receptionist â Automated Onboarding Endpoint v2
 * Vercel Serverless Function: /api/onboard
 *
 * Flow:
 * 1.  Tally webhook fires on new submission
 * 2.  Validate signature
 * 3.  Parse & map all Tally fields
 * 4.  Build personalised system prompt
 * 5.  Create Retell LLM
 * 6.  Create Retell Agent
 * 7.  Provision phone number (Twilio new number OR store existing)
 * 8.  Register phone number with Retell (if provisioned)
 * 9.  Insert client record into Supabase
 * 10. Log new client to Google Sheets tracker
 * 11. Send branded welcome email to client
 * 12. Send work order notification to Andy
 *
 * Required env vars (Vercel â Settings â Environment Variables):
 *   RETELL_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *   RESEND_API_KEY
 *   OTW_FROM_EMAIL            (andy@otwstudios.com.au)
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   GOOGLE_SHEETS_ID          (spreadsheet ID from URL)
 *   GOOGLE_SERVICE_ACCOUNT_KEY (JSON string of service account key)
 *   TALLY_SIGNING_SECRET      (optional but recommended)
 */

import crypto from "crypto";

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// FIELD PARSER
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
function parseTallyFields(fields = []) {
  const map = {};
  for (const field of fields ?? []) {
    const key = field.label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/_+$/, "");
    map[key] = Array.isArray(field.value)
      ? field.value.join(", ")
      : field.value ?? "";
  }
  return map;
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// SYSTEM PROMPT BUILDER
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
function buildSystemPrompt(d) {
  return `You are ${d.agent_name || "Alex"}, the AI receptionist for ${d.business_name}. You answer all incoming calls professionally and helpfully on behalf of the business.

BUSINESS INFORMATION:
- Business name: ${d.business_name}
- Trade / industry: ${d.trade || "trades"}
- Location: ${d.state || "Australia"}
- Service area: ${d.service_area || "local area"}
- Operating hours: ${d.operating_hours || "Monday to Friday, business hours"}

SERVICES WE OFFER:
${d.services_offered || "General trade services â ask the caller what they need"}

SERVICES WE DO NOT OFFER:
${d.services_not_offered || "None specified"}

PRICING & QUOTES:
${d.pricing_info || "Pricing varies â we provide quotes on assessment"}
Free quotes: ${d.free_quotes === "Yes" ? "Yes, we offer free quotes." : "No â a site assessment fee may apply."}

AFTER-HOURS HANDLING:
${d.after_hours_handling || "Take a message and advise we'll call back next business day"}

EMERGENCY CONTACT NUMBER: ${d.emergency_contact || "000 for life-threatening emergencies"}
CALLBACK WINDOW: ${d.callback_time || "We aim to call back within 2 hours during business hours"}

URGENCY KEYWORDS â if caller uses any of these words, treat the call as urgent and provide the emergency contact:
${d.urgency_keywords || "burst pipe, gas leak, flooding, no power, no hot water, emergency"}

CALL SUMMARY DESTINATION: ${d.notification_email || ""}

${d.custom_notes ? `ADDITIONAL INSTRUCTIONS:\n${d.custom_notes}` : ""}

YOUR BEHAVIOUR:
- Always greet callers warmly and introduce yourself as the receptionist for ${d.business_name}
- Collect: caller's full name, best contact number, and the reason for their call
- For urgent calls matching the urgency keywords: acknowledge the urgency, provide the emergency contact, and confirm we'll follow up
- Never quote specific prices beyond what is listed above
- Always reassure the caller that their message will be passed to the team
- If asked something you don't know, say "That's a great question â let me take your details and have someone from the team get back to you"
- Keep responses concise and natural â this is a phone call, not a chat`;
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// EMAIL TEMPLATES
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
function clientWelcomeEmail(c, phoneNumber, agentCreated) {
  const phoneSection = phoneNumber
    ? `
    <div style="background:#1a2235;border:1px solid rgba(245,158,11,0.30);border-radius:12px;padding:20px 24px;margin:24px 0;">
      <div style="font-size:10px;font-weight:800;color:#F59E0B;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:8px;">Your AI Receptionist Number</div>
      <div style="font-size:28px;font-weight:900;color:#F8FAFC;letter-spacing:0.04em;">${phoneNumber}</div>
      <div style="font-size:12px;color:rgba(248,250,252,0.55);margin-top:6px;">Forward your existing business number to this line, or start using it directly.</div>
    </div>`
    : `
    <div style="background:#1a2235;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:20px 24px;margin:24px 0;">
      <div style="font-size:13px;color:rgba(248,250,252,0.65);">ð Your phone number is being finalised â Your AI receptionist number is being provisioned automatically — it will be ready within the hour. No action needed from you.</div>
    </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Welcome to OTW AI Receptionist</title></head>
<body style="margin:0;padding:0;background:#04080F;font-family:'Inter',system-ui,sans-serif;color:#F8FAFC;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#04080F;padding:40px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

        <!-- HEADER -->
        <tr><td style="padding-bottom:32px;">
          <table cellpadding="0" cellspacing="0">
            <tr>
              <td style="width:8px;height:8px;background:#F59E0B;border-radius:50%;vertical-align:middle;"></td>
              <td style="width:10px;"></td>
              <td>
                <div style="font-size:14px;font-weight:800;color:#F8FAFC;line-height:1;">OTW Studios</div>
                <div style="font-size:9px;font-weight:700;color:#F59E0B;letter-spacing:0.14em;text-transform:uppercase;line-height:1;margin-top:2px;">AI RECEPTIONIST</div>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- HERO -->
        <tr><td style="background:#0C1117;border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:36px 32px;margin-bottom:16px;">
          <div style="font-size:10px;font-weight:800;color:#F59E0B;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:12px;">ð You're in</div>
          <h1 style="font-size:28px;font-weight:900;color:#F8FAFC;margin:0 0 12px;letter-spacing:-0.025em;line-height:1.2;">
            Welcome aboard,<br>${c.owner_first_name}!
          </h1>
          <p style="font-size:14px;color:rgba(248,250,252,0.65);margin:0;line-height:1.65;">
            Your AI receptionist for <strong style="color:#F8FAFC;">${c.business_name}</strong> ${agentCreated ? "is built and ready" : "is being set up right now"}. Here's everything you need to know.
          </p>

          ${phoneSection}

          ${agentCreated ? `
          <div style="background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.22);border-radius:10px;padding:14px 18px;margin-bottom:0;">
            <div style="font-size:12px;font-weight:700;color:#22C55E;">â Agent "${c.agent_name}" is live</div>
            <div style="font-size:11px;color:rgba(248,250,252,0.55);margin-top:3px;">Your AI is configured with your services, pricing, hours and service area.</div>
          </div>` : ""}
        </td></tr>

        <tr><td style="height:12px;"></td></tr>

        <!-- WHAT HAPPENS NEXT -->
        <tr><td style="background:#0C1117;border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:28px 32px;">
          <div style="font-size:10px;font-weight:800;color:#F59E0B;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:20px;">What happens next</div>

          <table cellpadding="0" cellspacing="0" width="100%">
            ${[
              ["1", "Test your AI receptionist", `Call ${phoneNumber || "your new number"} from your mobile to hear your AI receptionist live — make sure it sounds right for your business.`],
              ["2", "Forward your number (optional)", `If you have an existing business number, forward it to ${phoneNumber || "your new number"} â callers won't notice any difference.`],
              ["3", "Go live", "Your AI starts answering every call, collecting leads, handling after-hours, and sending you summaries."],
              ["4", "Check your summaries", `Call summaries will be emailed to ${c.notification_email || c.owner_email} after every call.`],
            ].map(([n, title, desc]) => `
            <tr>
              <td style="vertical-align:top;width:32px;padding-bottom:20px;">
                <div style="width:24px;height:24px;background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.30);border-radius:50%;text-align:center;line-height:24px;font-size:11px;font-weight:800;color:#F59E0B;">${n}</div>
              </td>
              <td style="padding-left:14px;padding-bottom:20px;vertical-align:top;">
                <div style="font-size:13px;font-weight:700;color:#F8FAFC;margin-bottom:3px;">${title}</div>
                <div style="font-size:12px;color:rgba(248,250,252,0.55);line-height:1.55;">${desc}</div>
              </td>
            </tr>`).join("")}
          </table>
        </td></tr>

        <tr><td style="height:12px;"></td></tr>

        <!-- FREE TRIAL REMINDER -->
        <tr><td style="background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.20);border-radius:12px;padding:18px 24px;">
          <div style="font-size:13px;color:#F8FAFC;line-height:1.6;">
            <strong style="color:#F59E0B;">30-day free trial.</strong> No charge until your trial ends. You'll receive a reminder before it ends — no surprises.
          </div>
        </td></tr>

        <tr><td style="height:28px;"></td></tr>

        <!-- SIGN OFF -->
        <tr><td>
          <p style="font-size:13px;color:rgba(248,250,252,0.65);margin:0 0 6px;">Questions? Just reply to this email.</p>
          <p style="font-size:14px;color:#F8FAFC;margin:0;font-weight:600;">Andy Ngo<br>
          <span style="font-weight:400;color:rgba(248,250,252,0.55);">OTW Studios Â· <a href="mailto:andy@otwstudios.com.au" style="color:#F59E0B;text-decoration:none;">andy@otwstudios.com.au</a></span></p>
        </td></tr>

        <!-- FOOTER -->
        <tr><td style="padding-top:32px;text-align:center;">
          <p style="font-size:11px;color:rgba(248,250,252,0.20);margin:0;">Powered by OTW Studios Â· <a href="https://otwstudios.com.au" style="color:rgba(248,250,252,0.30);">otwstudios.com.au</a></p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function andyWorkOrderEmail(c, retellAgentId, retellLlmId, phoneNumber, phoneProvisioned, supabaseOk) {
  const statusRow = (label, ok, detail = "") => `
    <tr>
      <td style="padding:10px 14px;border-bottom:1px solid #1e293b;font-size:12px;color:#94a3b8;width:140px;">${label}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #1e293b;font-size:12px;">
        <span style="color:${ok ? "#22C55E" : "#EF4444"};font-weight:700;">${ok ? "â" : "â"} ${ok ? "Done" : "Failed"}</span>
        ${detail ? `<span style="color:#64748b;margin-left:8px;">${detail}</span>` : ""}
      </td>
    </tr>`;

  const dataRow = (label, value) => `
    <tr>
      <td style="padding:9px 14px;border-bottom:1px solid #1e293b;font-size:12px;color:#94a3b8;width:160px;white-space:nowrap;">${label}</td>
      <td style="padding:9px 14px;border-bottom:1px solid #1e293b;font-size:13px;color:#e2e8f0;">${value || "<span style='color:#475569'>â</span>"}</td>
    </tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>New Client Work Order</title></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:'Inter',system-ui,sans-serif;color:#e2e8f0;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:32px 16px;">
    <tr><td align="center">
      <table width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;">

        <!-- ALERT BADGE -->
        <tr><td style="padding-bottom:20px;">
          <div style="display:inline-block;background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.30);border-radius:50px;padding:6px 16px;font-size:11px;font-weight:800;color:#F59E0B;letter-spacing:0.10em;text-transform:uppercase;">ð New Client Onboarded</div>
        </td></tr>

        <!-- HEADING -->
        <tr><td style="padding-bottom:24px;">
          <h1 style="font-size:24px;font-weight:900;color:#f8fafc;margin:0 0 6px;letter-spacing:-0.02em;">${c.business_name}</h1>
          <p style="font-size:13px;color:#64748b;margin:0;">${new Date().toLocaleDateString("en-AU", { weekday:"long", day:"numeric", month:"long", year:"numeric", hour:"2-digit", minute:"2-digit", timeZone:"Australia/Perth" })} AWST</p>
        </td></tr>

        <!-- SETUP STATUS -->
        <tr><td style="background:#1e293b;border:1px solid #334155;border-radius:12px;overflow:hidden;margin-bottom:16px;">
          <div style="background:#1e293b;padding:12px 14px;border-bottom:1px solid #334155;">
            <span style="font-size:10px;font-weight:800;color:#F59E0B;letter-spacing:0.12em;text-transform:uppercase;">Setup Status</span>
          </div>
          <table width="100%" cellpadding="0" cellspacing="0">
            ${statusRow("Retell LLM", !!retellLlmId, retellLlmId ? retellLlmId.substring(0, 16) + "â¦" : "")}
            ${statusRow("Retell Agent", !!retellAgentId, retellAgentId ? retellAgentId.substring(0, 16) + "â¦" : "")}
            ${statusRow("Phone Number", !!(phoneNumber), phoneNumber || (phoneProvisioned ? "Provisioned" : "Pending"))}
            ${statusRow("Supabase Record", supabaseOk)}
          </table>
        </td></tr>

        <tr><td style="height:12px;"></td></tr>

        <!-- CLIENT DETAILS -->
        <tr><td style="background:#1e293b;border:1px solid #334155;border-radius:12px;overflow:hidden;">
          <div style="background:#1e293b;padding:12px 14px;border-bottom:1px solid #334155;">
            <span style="font-size:10px;font-weight:800;color:#F59E0B;letter-spacing:0.12em;text-transform:uppercase;">Client Details</span>
          </div>
          <table width="100%" cellpadding="0" cellspacing="0">
            ${dataRow("Business", c.business_name)}
            ${dataRow("Owner", c.owner_first_name)}
            ${dataRow("Email", `<a href="mailto:${c.owner_email}" style="color:#F59E0B;">${c.owner_email}</a>`)}
            ${dataRow("Mobile", c.owner_mobile)}
            ${dataRow("Trade", c.trade)}
            ${dataRow("State", c.state)}
            ${dataRow("Service Area", c.service_area)}
            ${dataRow("Hours", c.operating_hours)}
            ${dataRow("After Hours", c.after_hours_handling)}
            ${dataRow("Agent Name", c.agent_name)}
            ${dataRow("Notification Email", c.notification_email)}
            ${dataRow("Emergency Contact", c.emergency_contact)}
            ${dataRow("Phone Number", phoneNumber || "â³ Pending")}
            ${dataRow("Phone Preference", c.phone_preference === "provision_new" ? "New number requested" : `Existing: ${c.existing_phone_number || "not entered"}`)}
          </table>
        </td></tr>

        <tr><td style="height:12px;"></td></tr>

        <!-- SYSTEM IDS -->
        <tr><td style="background:#1e293b;border:1px solid #334155;border-radius:12px;overflow:hidden;">
          <div style="background:#1e293b;padding:12px 14px;border-bottom:1px solid #334155;">
            <span style="font-size:10px;font-weight:800;color:#F59E0B;letter-spacing:0.12em;text-transform:uppercase;">System IDs</span>
          </div>
          <table width="100%" cellpadding="0" cellspacing="0">
            ${dataRow("Retell Agent ID", retellAgentId ? `<code style="font-size:11px;color:#94a3b8;">${retellAgentId}</code>` : "â")}
            ${dataRow("Retell LLM ID", retellLlmId ? `<code style="font-size:11px;color:#94a3b8;">${retellLlmId}</code>` : "â")}
          </table>
        </td></tr>

        <tr><td style="height:12px;"></td></tr>

        <!-- ACTION CHECKLIST -->
        <tr><td style="background:#1e293b;border:1px solid #334155;border-radius:12px;padding:20px 22px;">
          <div style="font-size:10px;font-weight:800;color:#F59E0B;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:14px;">Action Checklist</div>
          ${[
            [!retellAgentId, "Manually create Retell agent (auto-setup failed)"],
            [!phoneNumber, "Provision or confirm phone number, update Supabase"],
            [true, "Do a test call to verify agent sounds right"],
            [true, "Confirm welcome email received by client"],
            [true, "Schedule 7-day check-in with client"],
          ].map(([pending, text]) => `
          <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:10px;">
            <span style="color:${pending ? "#ef4444" : "#64748b"};font-size:14px;line-height:1.4;">${pending ? "â»ï¸" : "âï¸"}</span>
            <span style="font-size:13px;color:${pending ? "#e2e8f0" : "#64748b"};line-height:1.4;">${text}</span>
          </div>`).join("")}
        </td></tr>

        <tr><td style="height:20px;"></td></tr>

        <!-- CTA BUTTONS -->
        <tr><td>
          <table cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding-right:10px;">
                <a href="https://dashboard.retellai.com/agents" style="display:inline-block;background:#F59E0B;color:#04080F;font-size:12px;font-weight:800;padding:10px 20px;border-radius:50px;text-decoration:none;letter-spacing:0.02em;">Retell Dashboard â</a>
              </td>
              <td>
                <a href="https://supabase.com/dashboard/project/xdqflhekkxuyxizgdahe/editor" style="display:inline-block;background:#1e293b;border:1px solid #334155;color:#e2e8f0;font-size:12px;font-weight:600;padding:10px 20px;border-radius:50px;text-decoration:none;">Supabase â</a>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- FOOTER -->
        <tr><td style="padding-top:32px;text-align:center;">
          <p style="font-size:11px;color:#334155;margin:0;">OTW Studios Â· Internal Work Order Â· Do not forward</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// TWILIO HELPERS
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const STATE_AREA_CODES = {
  NSW: "02", VIC: "03", QLD: "07", SA: "08", WA: "08",
  TAS: "03", ACT: "02", NT: "08",
};

async function searchTwilioNumber(accountSid, authToken, areaCode) {
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/AvailablePhoneNumbers/AU/Local.json?AreaCode=${areaCode}&Limit=1`,
    { headers: { Authorization: `Basic ${auth}` } }
  );
  const data = await res.json();
  return data.available_phone_numbers?.[0]?.phone_number || null;
}

async function buyTwilioNumber(accountSid, authToken, phoneNumber, retellAgentId) {
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const body = new URLSearchParams({
    PhoneNumber: phoneNumber,
    VoiceUrl: `https://api.retellai.com/twilio-voice-webhook/${retellAgentId}`,
    VoiceMethod: "POST",
    StatusCallback: `https://api.retellai.com/twilio-voice-webhook/${retellAgentId}`,
  });
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Twilio buy failed: ${JSON.stringify(data)}`);
  return data.phone_number;
}

async function registerNumberWithRetell(retellKey, phoneNumber, agentId) {
  const res = await fetch("https://api.retellai.com/create-phone-number", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${retellKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      phone_number: phoneNumber,
      inbound_agent_id: agentId,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.warn("[onboard] Retell phone registration warning:", JSON.stringify(data));
  }
  return data;
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// GOOGLE SHEETS HELPER
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
async function appendToGoogleSheet(sheetId, serviceAccountJson, row) {
  try {
    const sa = JSON.parse(serviceAccountJson);
    const now = Math.floor(Date.now() / 1000);
    const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
    const jwtHeader = b64url({ alg: "RS256", typ: "JWT" });
    const jwtPayload = b64url({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    });
    const signingInput = `${jwtHeader}.${jwtPayload}`;

    // Sign with RS256 using Web Crypto API (available in Vercel Edge / Node 18+)
    const privateKey = sa.private_key;
    const keyImport = await globalThis.crypto.subtle.importKey(
      "pkcs8",
      Uint8Array.from(
        atob(privateKey.replace(/-----.*?-----|\n/g, "")),
        c => c.charCodeAt(0)
      ),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await globalThis.crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keyImport,
      new TextEncoder().encode(signingInput)
    );
    const sigB64 = Buffer.from(sig).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
    const jwt = `${signingInput}.${sigB64}`;

    // Exchange JWT for access token
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error("No access token: " + JSON.stringify(tokenData));

    // Append row
    const appendRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!A:H:append?valueInputOption=USER_ENTERED`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ values: [row] }),
      }
    );
    if (!appendRes.ok) {
      const errText = await appendRes.text();
      throw new Error(`Sheets append failed: ${appendRes.status} ${errText}`);
    }
    return true;
  } catch (err) {
    console.error("[onboard] Google Sheets error:", err.message);
    return false;
  }
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// MAIN HANDLER
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Parse body
  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: "Invalid JSON body" });
  }

  // Validate Tally signature
  const signingSecret = process.env.TALLY_SIGNING_SECRET;
  if (signingSecret) {
    const signature = req.headers["tally-signature"];
    if (signature) {
      const rawBody = JSON.stringify(body);
      const expected = crypto.createHmac("sha256", signingSecret).update(rawBody).digest("hex");
      if (signature !== expected) {
        console.warn("[onboard] Invalid Tally signature");
        return res.status(401).json({ error: "Invalid signature" });
      }
    }
  }

  if (body.eventType !== "FORM_RESPONSE") {
    return res.status(200).json({ ok: true, skipped: true });
  }

  // Parse fields
  const fields = body.data?.fields ?? [];
  const d = parseTallyFields(fields);

  if (!d.business_name || !d.owner_email) {
    return res.status(400).json({ error: "Missing required fields: business_name, owner_email" });
  }

  const clientData = {
    business_name:      d.business_name,
    owner_first_name:   d.owner_first_name,
    owner_email:        d.owner_email,
    owner_mobile:       d.owner_mobile || d.mobile,
    trade:              d.trade_type || d.trade,
    state:              d.state,
    service_area:       d.service_area || d.suburbs_or_regions_you_cover,
    operating_hours:    d.business_hours || d.operating_hours,
    after_hours_handling: d.after_hours_calls,
    services_offered:   d.services_offered,
    services_not_offered: d.services_not_offered,
    pricing_info:       d.pricing_policy || d.pricing_information,
    free_quotes:        d.free_quotes,
    urgency_keywords:   d.urgency_keywords,
    emergency_contact:  d.emergency_callback_number || d.emergency_contact,
    callback_time:      d.callback_window || d.callback_time,
    agent_name:         d.agent_name || "Alex",
    custom_notes:       d.custom_notes,
    notification_email: d.notification_email || d.owner_email,
    // Phone number fields (new in v2)
    phone_preference:    d.phone_number_setup || d.phone_number_preference || d.do_you_want_a_new_number_or_use_your_existing || "provision_new",
    existing_phone_number: d.existing_phone_number_if_using_your_own || d.existing_phone_number || d.your_existing_phone_number || null,
  };

  console.log("[onboard] Processing:", clientData.business_name, "| Phone pref:", clientData.phone_preference);

  const retellKey    = process.env.RETELL_API_KEY;
  const supabaseUrl  = process.env.SUPABASE_URL;
  const supabaseKey  = process.env.SUPABASE_SERVICE_KEY;
  const resendKey    = process.env.RESEND_API_KEY;
  const fromEmail    = process.env.OTW_FROM_EMAIL || "andy@otwstudios.com.au";
  const twilioSid    = process.env.TWILIO_ACCOUNT_SID;
  const twilioAuth   = process.env.TWILIO_AUTH_TOKEN;
  const sheetId      = process.env.GOOGLE_SHEETS_ID;
  const sheetSaKey   = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

  let retellLlmId    = null;
  let retellAgentId  = null;
  let phoneNumber    = clientData.existing_phone_number || null;
  let phoneProvisioned = false;
  let supabaseOk     = false;

  // ââ STEP 5: Create Retell LLM âââââââââââââââââââââââââ
  if (retellKey) {
    try {
      const llmRes = await fetch("https://api.retellai.com/create-retell-llm", {
        method: "POST",
        headers: { Authorization: `Bearer ${retellKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          general_prompt: buildSystemPrompt(clientData),
          general_tools: [{ type: "end_call", name: "end_call", description: "End the call when conversation is complete" }],
        }),
      });
      const llmData = await llmRes.json();
      if (!llmRes.ok) throw new Error(`LLM creation failed: ${llmRes.status} â ${JSON.stringify(llmData)}`);
      retellLlmId = llmData.llm_id;
      console.log("[onboard] Retell LLM:", retellLlmId);
    } catch (err) {
      console.error("[onboard] Retell LLM error:", err.message);
    }
  }

  // ââ STEP 6: Create Retell Agent âââââââââââââââââââââââ
  if (retellKey && retellLlmId) {
    try {
      const agentRes = await fetch("https://api.retellai.com/create-agent", {
        method: "POST",
        headers: { Authorization: `Bearer ${retellKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          response_engine: { type: "retell-llm", llm_id: retellLlmId },
          agent_name: `${clientData.business_name} â ${clientData.agent_name}`,
          voice_id: "11labs-Adrian",
          language: "en-AU",
          ambient_sound: "call-center",
          boosted_keywords: clientData.urgency_keywords
            ? clientData.urgency_keywords.split(",").map(k => k.trim()).filter(Boolean)
            : [],
        }),
      });
      const agentData = await agentRes.json();
      if (!agentRes.ok) throw new Error(`Agent creation failed: ${agentRes.status} â ${JSON.stringify(agentData)}`);
      retellAgentId = agentData.agent_id;
      console.log("[onboard] Retell Agent:", retellAgentId);
    } catch (err) {
      console.error("[onboard] Retell Agent error:", err.message);
    }
  }

  // ââ STEP 7: Phone Number Provisioning âââââââââââââââââ
  // Always provision a Twilio number — used directly (new number) or as a forwarding backend (own number)
  if (retellAgentId && twilioSid && twilioAuth) {
    try {
      const stateKey = (clientData.state || "").toUpperCase().trim();
      const areaCode = STATE_AREA_CODES[stateKey] || "02";
      const availableNumber = await searchTwilioNumber(twilioSid, twilioAuth, areaCode);
      if (availableNumber) {
        phoneNumber = await buyTwilioNumber(twilioSid, twilioAuth, availableNumber, retellAgentId);
        phoneProvisioned = true;
        console.log("[onboard] Twilio number provisioned:", phoneNumber);
      } else {
        console.warn("[onboard] No Twilio numbers available for area code:", areaCode);
      }
    } catch (err) {
      console.error("[onboard] Twilio error:", err.message);
    }
  }

  // ââ STEP 8: Register Number with Retell âââââââââââââââ
  if (phoneNumber && retellAgentId && retellKey) {
    try {
      await registerNumberWithRetell(retellKey, phoneNumber, retellAgentId);
      console.log("[onboard] Phone number registered with Retell");
    } catch (err) {
      console.error("[onboard] Retell phone registration error:", err.message);
    }
  }

  // ââ STEP 9: Supabase Insert âââââââââââââââââââââââââââ
  if (supabaseUrl && supabaseKey) {
    try {
      const sbRes = await fetch(`${supabaseUrl}/rest/v1/receptionist_clients`, {
        method: "POST",
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          business_name:         clientData.business_name,
          owner_first_name:      clientData.owner_first_name,
          owner_email:           clientData.owner_email,
          owner_mobile:          clientData.owner_mobile,
          trade_type:            clientData.trade,
          state:                 clientData.state,
          service_area:          clientData.service_area,
          operating_hours:       clientData.operating_hours,
          services_offered:      clientData.services_offered,
          services_not_offered:  clientData.services_not_offered,
          pricing_info:          clientData.pricing_info,
          free_quotes:           clientData.free_quotes,
          urgency_keywords:      clientData.urgency_keywords,
          agent_name:            clientData.agent_name,
          emergency_contact:     clientData.emergency_contact,
          callback_time:         clientData.callback_time,
          custom_notes:          clientData.custom_notes,
          notification_email:    clientData.notification_email,
          phone_number:          phoneNumber,
          phone_provisioned:     phoneProvisioned,
          retell_agent_id:       retellAgentId,
          retell_llm_id:         retellLlmId,
          status:                retellAgentId ? "active" : "pending_setup",
        }),
      });
      if (!sbRes.ok) throw new Error(`Supabase insert: ${sbRes.status} ${await sbRes.text()}`);
      supabaseOk = true;
      console.log("[onboard] Supabase record inserted");
    } catch (err) {
      console.error("[onboard] Supabase error:", err.message);
    }
  }

  // ─── STEP 10: Google Sheets Logging ────────────────────────────────────────
  if (sheetId && sheetSaKey) {
    const row = [
      new Date().toISOString(),        // Timestamp
      clientData.business_name,        // Business Name
      clientData.owner_first_name,     // Owner Name
      clientData.owner_email,          // Email
      clientData.owner_mobile || "",   // Phone
      retellAgentId || "",             // Agent ID
      phoneNumber || "",               // Phone Number
      "Free Trial",                    // Plan
    ];
    await appendToGoogleSheet(sheetId, sheetSaKey, row);
  }

  // ââ STEP 11: Client Welcome Email âââââââââââââââââââââ
  if (resendKey && clientData.owner_email) {
    try {
      const emailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: `Andy at OTW Studios <${fromEmail}>`,
          to: [clientData.owner_email],
          reply_to: "andy@otwstudios.com.au",
          subject: `Your AI Receptionist is being set up, ${clientData.owner_first_name} ð`,
          html: clientWelcomeEmail(clientData, phoneNumber, !!retellAgentId),
        }),
      });
      if (!emailRes.ok) throw new Error(`Welcome email: ${emailRes.status} ${await emailRes.text()}`);
      console.log("[onboard] Welcome email sent to:", clientData.owner_email);
    } catch (err) {
      console.error("[onboard] Welcome email error:", err.message);
    }
  }

  // ââ STEP 12: Andy Work Order ââââââââââââââââââââââââââ
  if (resendKey) {
    try {
      const notifyRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: `OTW Onboarding <${fromEmail}>`,
          to: ["andy@otwstudios.com.au"],
          subject: `ð Work Order â ${clientData.business_name}`,
          html: andyWorkOrderEmail(clientData, retellAgentId, retellLlmId, phoneNumber, phoneProvisioned, supabaseOk),
        }),
      });
      if (!notifyRes.ok) throw new Error(`Work order email: ${notifyRes.status} ${await notifyRes.text()}`);
      console.log("[onboard] Work order sent to Andy");
    } catch (err) {
      console.error("[onboard] Andy notification error:", err.message);
    }
  }

  return res.status(200).json({
    ok: true,
    business: clientData.business_name,
    retell_agent_id: retellAgentId,
    retell_llm_id: retellLlmId,
    phone_number: phoneNumber,
    phone_provisioned: phoneProvisioned,
    supabase: supabaseOk,
  });
}
