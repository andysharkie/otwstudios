// lib/gemini.js — Gemini 2.0 Flash: email triage + draft reply generation
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
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-lite' });

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
- Keep replies concise — tradies are busy`;

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
