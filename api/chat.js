// api/chat.js â Process natural language commands from the TriageAI chat panel
import { getSession } from '../lib/session.js';
import { getDb } from '../lib/db.js';
import { chatCommand } from '../lib/gemini.js';
import { createGmailLabel, applyLabelToMessage } from '../lib/gmail.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const client = await getSession(req);
  if (!client) return res.status(401).json({ error: 'Not authenticated' });

  const { message, email_cache_id } = req.body || {};
  if (!message?.trim()) return res.status(400).json({ error: 'Missing message' });

  const db = getDb();

  // ââ Load context in parallel ââââââââââââââââââââââââââââââââââââââââââ
  const [emailRes, profileRes, rulesRes] = await Promise.all([
    email_cache_id
      ? db.from('email_cache').select('*').eq('id', email_cache_id).eq('client_id', client.id).single()
      : Promise.resolve({ data: null }),
    db.from('business_profiles').select('profile').eq('client_id', client.id).single(),
    db.from('chat_rules')
      .select('rule_text, action_type')
      .eq('client_id', client.id)
      .order('created_at', { ascending: false })
      .limit(15),
  ]);

  const email      = emailRes.data;
  const business   = profileRes.data?.profile || {};
  const chatRules  = rulesRes.data || [];

  // ââ Call Gemini to interpret command ââââââââââââââââââââââââââââââââââ
  let parsed;
  try {
    parsed = await chatCommand(message.trim(), email, business, chatRules);
  } catch (err) {
    console.error('[chat] Gemini failed:', err.message);
    return res.status(500).json({ error: 'AI processing failed', details: err.message });
  }

  const effects = [];

  // ââ Execute: no-draft âââââââââââââââââââââââââââââââââââââââââââââââââ
  if (parsed.action === 'no-draft' && email_cache_id) {
    await db.from('email_cache')
      .update({ draft: null, skip_draft: true })
      .eq('id', email_cache_id)
      .eq('client_id', client.id);
    effects.push({ type: 'email-updated', email_cache_id, changes: { draft: null, skip_draft: true } });
  }

  // ââ Execute: label ââââââââââââââââââââââââââââââââââââââââââââââââââââ
  if (parsed.action === 'label' && parsed.label_name && email_cache_id) {
    // Find or create label in DB
    let { data: label } = await db
      .from('labels')
      .select('*')
      .eq('client_id', client.id)
      .ilike('name', parsed.label_name.trim())
      .single();

    if (!label) {
      try {
        const gmailLabel = await createGmailLabel(client.id, parsed.label_name.trim());
        const { data: newLabel } = await db
          .from('labels')
          .insert({
            client_id:      client.id,
            gmail_label_id: gmailLabel.id,
            name:           gmailLabel.name,
          })
          .select()
          .single();
        label = newLabel;
      } catch (err) {
        console.error('[chat] Failed to create label:', err.message);
      }
    }

    if (label) {
      // Apply to this email in DB
      await db.from('email_labels').upsert(
        { email_cache_id, label_id: label.id, added_at: new Date().toISOString() },
        { onConflict: 'email_cache_id,label_id' }
      );

      // Sync to Gmail
      try {
        if (email?.gmail_message_id) {
          await applyLabelToMessage(client.id, email.gmail_message_id, label.gmail_label_id);
        }
      } catch (err) {
        console.error('[chat] Gmail label sync failed:', err.message);
      }

      effects.push({ type: 'label-applied', label, email_cache_id });
    }
  }

  // ââ Execute: set-category âââââââââââââââââââââââââââââââââââââââââââââ
  if (parsed.action === 'set-category' && parsed.category && email_cache_id) {
    await db.from('email_cache')
      .update({ category: parsed.category })
      .eq('id', email_cache_id)
      .eq('client_id', client.id);
    effects.push({ type: 'category-updated', email_cache_id, category: parsed.category });
  }

  // ââ Save persistent rule if scope is future/pattern/all-from-sender âââ
  const persistScopes = ['future', 'pattern', 'all-from-sender'];
  if (parsed.rule_description && persistScopes.includes(parsed.scope)) {
    const { data: rule } = await db
      .from('chat_rules')
      .insert({
        client_id:    client.id,
        rule_text:    parsed.rule_description,
        action_type:  parsed.action,
        action_params: {
          label_name: parsed.label_name   || null,
          category:   parsed.category    || null,
          pattern:    parsed.pattern     || null,
        },
      })
      .select()
      .single();

    if (rule) effects.push({ type: 'rule-created', rule });
  }

  return res.status(200).json({
    confirmation: parsed.confirmation,
    action:       parsed.action,
    effects,
  });
}
