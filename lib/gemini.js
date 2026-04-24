// lib/gemini.js â Gemini 2.5 Flash: email triage + draft reply generation + chat commands
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
 *
 * @param {object} email - { subject, body, from_name, from_email }
 * @param {object} business - the client's business profile
 * @param {Array}  learnedRules - array of { original_subject, original_body, edited_reply }
 * @returns {{ category: 'urgent'|'work'|'inbox', draft: string }}
 */
export async function triageEmail(email, business, learnedRules = []) {
  const genAI = getGenAI();
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-latest' });

  // Build few-shot examples from learned rules
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

  const prompt = `You are an AI email assistant for a trades business. Your job is to:
1. Classify the email into one of three categories
2. Draft a reply in the owner's voice

## BUSINESS PROFILE
${businessContext}
${examplesBlock}

## CATEGORIES
- urgent: Immediate emergency (flooding, gas leak, no power/water, safety risk). Must be dealt with now.
- work: Quote request, job enquiry, booking, invoice/admin, builder contact. Revenue-generating.
- inbox: Everything else (reviews, spam, general enquiries, marketing).

## EMAIL TO CLASSIFY
From: ${email.from_name} <${email.from_email}>
Subject: ${email.subject}
Body:
${email.body}

## YOUR TASK
Return ONLY valid JSON (no markdown, no explanation) in this exact format:
{
  "category": "urgent" | "work" | "inbox",
  "draft": "the complete reply email text, ready to send"
}

Rules for the draft:
- Write in the owner's voice and tone
- Use the email signature provided
- For urgent emails: acknowledge urgency, give immediate guidance, state ETA
- For work emails: be professional, provide helpful info, move toward booking/site visit
- For inbox emails: brief, warm, appreciative
- Never invent specific prices unless they are in the business profile
- Keep replies concise â tradies are busy`;

  const result  = await model.generateContent(prompt);
  const text    = result.response.text().trim();

  // Strip any markdown code fences if present
  const clean = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  try {
    const parsed = JSON.parse(clean);
    if (!['urgent', 'work', 'inbox'].includes(parsed.category)) {
      parsed.category = 'inbox';
    }
    return parsed;
  } catch (e) {
    // Fallback if JSON parse fails
    console.error('[Gemini] Failed to parse response:', text);
    return {
      category: 'inbox',
      draft: 'Thank you for your email. We will be in touch shortly.',
    };
  }
}

/**
 * Parse a natural language chat command and return a structured action.
 *
 * @param {string} message        - The user's command text
 * @param {object|null} email     - The currently open email (or null)
 * @param {object} business       - The client's business profile
 * @param {Array}  chatRules      - Existing persistent rules for context
 * @returns structured action object
 */
export async function chatCommand(message, email, business, chatRules = []) {
  const genAI = getGenAI();
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const bizContext = `Business: ${business.name || 'Unknown'} | Owner: ${business.owner || 'Unknown'}`;

  const emailContext = email
    ? `\n## CURRENT EMAIL\nFrom: ${email.from_name} <${email.from_email}>\nSubject: ${email.subject}\nCategory: ${email.category || 'inbox'}`
    : '\n## CURRENT EMAIL\nNo email currently selected.';

  const rulesContext = chatRules.length > 0
    ? `\n## EXISTING RULES\n${chatRules.map(r => `- ${r.rule_text}`).join('\n')}`
    : '';

  const prompt = `You are the AI assistant for OTW TriageAI, an email management tool for tradespeople.
The user is issuing a natural language command to control how emails are handled.

${bizContext}
${emailContext}
${rulesContext}

## USER COMMAND
"${message}"

## YOUR TASK
Parse this command and return ONLY valid JSON (no markdown, no explanation):
{
  "action": "no-draft" | "label" | "set-category" | "create-rule" | "info" | "unclear",
  "scope": "this-email" | "all-from-sender" | "pattern" | "future",
  "label_name": "label name if action is label, otherwise null",
  "category": "urgent" | "work" | "inbox" | null,
  "rule_description": "concise human-readable summary of the rule (if scope is future/all-from-sender/pattern, otherwise null)",
  "pattern": {
    "from_contains": "email/domain to match or null",
    "subject_contains": "subject keyword or null",
    "category": "category to match or null"
  },
  "confirmation": "Short friendly message to show the user confirming what was done (1-2 sentences)"
}

Action guide:
- "no-draft": Stop generating AI draft replies for matching email(s)
- "label": Apply a Gmail label/tag to email(s) â set label_name
- "set-category": Change the triage category (urgent/work/inbox)
- "create-rule": Save a standing rule without a specific email action
- "info": Answer a question (put the answer in confirmation)
- "unclear": Command is ambiguous â explain in confirmation what you can do

Scope guide:
- "this-email": Action applies only to the currently open email
- "all-from-sender": Action applies to all emails from this sender (creates a persistent rule)
- "pattern": Action applies to emails matching subject/category pattern (creates a persistent rule)
- "future": Generic future rule

If scope is all-from-sender/pattern/future, include rule_description so it is saved as a persistent rule.
Keep confirmation messages conversational and concise (like a smart assistant).`;

  const result = await model.generateContent(prompt);
  const text   = result.response.text().trim();
  const clean  = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  try {
    return JSON.parse(clean);
  } catch (e) {
    console.error('[Gemini] chatCommand parse failed:', text);
    return {
      action: 'unclear',
      confirmation: "I'm not sure what you'd like me to do. Try: \"don't draft this email\", \"label as Subscriptions\", or \"mark as urgent\".",
    };
  }
}
