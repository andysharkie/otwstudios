// lib/gemini.js — Gemini 2.5 Flash: email triage + draft reply generation + chat commands
import { GoogleGenerativeAI } from '@google/generative-ai';

let _genAI = null;

function getGenAI() {
  if (!_genAI) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('Missing GEMINI_API_KEY env var');
    _genAI = new GoogleGenerativeAI(key);
  }
  return _genAI;
}

/**
 * Classify an email and generate a draft reply.
 * Also detects job/quote signals for ServiceM8 + Xero integration.
 */
export async function triageEmail(email, business, learnedRules = []) {
  const genAI = getGenAI();
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-latest' });

  let examplesBlock = '';
  if (learnedRules.length > 0) {
    examplesBlock = '\n\n### HOW THIS OWNER LIKES TO REPLY (few-shot examples)\n';
    learnedRules.slice(-5).forEach(rule => {
      examplesBlock += `\nOriginal email subject: "${rule.original_subject || 'N/A'}"\n`;
      examplesBlock += `Owner's reply:\n${rule.edited_reply}\n---`;
    });
  }

  const businessContext = `
Business name: ${business.name || 'Unknown'}
Owner: ${business.owner || 'Unknown'}
Phone: ${business.phone || 'N/A'}
Services: ${business.services || 'N/A'}
Service area: ${business.serviceArea || 'N/A'}
Hourly rate: $${business.hourlyRate || 'N/A'}/hr
Call-out fee: $${business.callOutFee || 'N/A'}
Email signature: ${business.signature || ''}
Tone: ${business.tone || 'Professional and friendly'}`.trim();

  const prompt = `You are an AI email assistant for a trades business. Classify this email and generate a reply draft.

## BUSINESS PROFILE
${businessContext}
${examplesBlock}

## CATEGORIES
- urgent: Immediate emergency (flooding, gas leak, no power/water, safety risk).
- work: Quote request, job enquiry, booking, invoice/payment, builder contact. Revenue-generating.
- inbox: Everything else (reviews, spam, general enquiries, marketing).

## JOB TYPES (only for "work" category emails)
- quote_request: Customer asking for a price/quote on work
- job_booking: Customer booking or confirming a job / appointment
- emergency: Urgent work request (hot water, burst pipe, no power, safety)
- invoice: Payment, invoice query, billing question

## EMAIL TO CLASSIFY
From: ${email.from_name} <${email.from_email}>
Subject: ${email.subject}
Body:
${email.body}

## YOUR TASK
Return ONLY valid JSON (no markdown, no explanation):
{
  "category": "urgent" | "work" | "inbox",
  "draft": "the complete reply email text, ready to send",
  "job_type": "quote_request" | "job_booking" | "emergency" | "invoice" | null,
  "customer_name": "full name extracted from email or null",
  "customer_address": "job address extracted from email or null",
  "job_description": "one-sentence summary of the work requested or null",
  "line_items": [{"description":"item","qty":1,"rate":0}] or null
}

Rules for the draft:
- Write in the owner's voice and tone
- Use the email signature provided
- For urgent: acknowledge urgency, give immediate guidance, state ETA
- For work: professional, helpful, move toward booking/site visit
- For inbox: brief, warm, appreciative
- Never invent prices unless in business profile
- Keep replies concise — tradies are busy
- job_type and line_items only needed for "work" emails; null for others
- line_items: only include if the email mentions specific materials/services with quantities`;

  const result = await model.generateContent(prompt);
  const text   = result.response.text().trim();
  const clean  = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  try {
    const parsed = JSON.parse(clean);
    if (!['urgent', 'work', 'inbox'].includes(parsed.category)) parsed.category = 'inbox';
    if (parsed.category !== 'work') {
      parsed.job_type = null;
      parsed.customer_name = null;
      parsed.customer_address = null;
      parsed.job_description = null;
      parsed.line_items = null;
    }
    return parsed;
  } catch (e) {
    console.error('[Gemini] Failed to parse triage response:', text);
    return {
      category: 'inbox',
      draft: 'Thank you for your email. We will be in touch shortly.',
      job_type: null, customer_name: null, customer_address: null,
      job_description: null, line_items: null,
    };
  }
}

/**
 * Parse a natural language chat command and return a structured action.
 */
export async function chatCommand(message, email, business, chatRules = []) {
  const genAI = getGenAI();
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const bizContext = `Business: ${business.name || 'Unknown'} | Owner: ${business.owner || 'Unknown'}`;

  const emailContext = email
    ? `\n## CURRENT EMAIL\nFrom: ${email.from_name} <${email.from_email}>\nSubject: ${email.subject}\nCategory: ${email.category || 'inbox'}\nJob type: ${email.job_type || 'none'}`
    : '\n## CURRENT EMAIL\nNo email currently selected.';

  const rulesContext = chatRules.length > 0
    ? `\n## EXISTING RULES\n${chatRules.map(r => `- ${r.rule_text}`).join('\n')}`
    : '';

  const prompt = `You are the AI assistant for OTW TriageAI — an email management + workflow tool for tradespeople.
The user issues natural language commands to manage emails AND trigger integrations (ServiceM8, Xero).

${bizContext}
${emailContext}
${rulesContext}

## USER COMMAND
"${message}"

## YOUR TASK
Parse this command and return ONLY valid JSON (no markdown, no explanation):
{
  "action": "no-draft" | "label" | "set-category" | "create-rule" | "info" | "unclear" | "sm8-create-job" | "sm8-create-quote" | "xero-create-quote" | "xero-create-invoice" | "xero-sync-contacts",
  "scope": "this-email" | "all-from-sender" | "pattern" | "future" | null,
  "label_name": "label name if action is label, otherwise null",
  "category": "urgent" | "work" | "inbox" | null,
  "rule_description": "concise human-readable rule summary, or null",
  "pattern": {
    "from_contains": "email/domain or null",
    "subject_contains": "keyword or null",
    "category": "category or null"
  },
  "confirmation": "Short friendly message confirming what will happen (1-2 sentences)"
}

## EMAIL MANAGEMENT ACTIONS
- "no-draft": Stop generating AI drafts for matching emails
- "label": Apply a label/tag to email(s) — set label_name
- "set-category": Change triage category
- "create-rule": Save a standing rule for future emails
- "info": Answer a question (put answer in confirmation)
- "unclear": Ambiguous — explain what you can do in confirmation

## INTEGRATION ACTIONS (ServiceM8 + Xero)
- "create a job", "log this as a job", "add to ServiceM8" → "sm8-create-job"
- "create a quote", "quote this in ServiceM8" → "sm8-create-quote"
- "raise a Xero quote", "create quote in Xero" → "xero-create-quote"
- "create invoice", "raise invoice in Xero" → "xero-create-invoice"
- "sync contacts", "pull Xero contacts" → "xero-sync-contacts"

For integration actions: scope = "this-email", confirmation explains what will happen.`;

  const result = await model.generateContent(prompt);
  const text   = result.response.text().trim();
  const clean  = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  try {
    return JSON.parse(clean);
  } catch (e) {
    console.error('[Gemini] chatCommand parse failed:', text);
    return {
      action: 'unclear',
      confirmation: "I'm not sure what you'd like me to do. Try: \"create a job in ServiceM8\", \"raise a Xero invoice\", \"label as Follow-up\", or \"mark as urgent\".",
    };
  }
}
