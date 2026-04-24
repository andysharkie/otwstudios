-- TriageAI: Labels + Chat feature migration
-- Run this in Supabase â SQL Editor

-- ââ 1. labels table ââââââââââââââââââââââââââââââââââââââââââââââââââââââ
CREATE TABLE IF NOT EXISTS labels (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  gmail_label_id  TEXT NOT NULL,
  name            TEXT NOT NULL,
  color           TEXT DEFAULT '#F59E0B',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(client_id, gmail_label_id)
);

-- ââ 2. email_labels junction table ââââââââââââââââââââââââââââââââââââââ
CREATE TABLE IF NOT EXISTS email_labels (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email_cache_id  UUID NOT NULL REFERENCES email_cache(id) ON DELETE CASCADE,
  label_id        UUID NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  added_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(email_cache_id, label_id)
);

-- ââ 3. chat_rules table (persistent AI rules) ââââââââââââââââââââââââââââ
CREATE TABLE IF NOT EXISTS chat_rules (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  rule_text       TEXT NOT NULL,
  action_type     TEXT NOT NULL,
  action_params   JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ââ 4. Add skip_draft flag to email_cache ââââââââââââââââââââââââââââââââ
ALTER TABLE email_cache
  ADD COLUMN IF NOT EXISTS skip_draft BOOLEAN DEFAULT FALSE;

-- ââ 5. Row-level security (same pattern as other tables) ââââââââââââââââ
ALTER TABLE labels      ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_rules  ENABLE ROW LEVEL SECURITY;

-- Service key bypasses RLS (server-side only) â no extra policies needed
-- for the service role. Add anon policies here if you ever expose these
-- tables to the client directly.

-- ââ Done âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
