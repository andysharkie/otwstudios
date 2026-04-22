-- OTW TriageAI — Supabase Schema
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query)

-- ────────────────────────────────────────────────
-- CLIENTS
-- One row per paying OTW client. Created on first Gmail OAuth completion.
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clients (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_email   TEXT NOT NULL UNIQUE,  -- the Gmail address they connected
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ────────────────────────────────────────────────
-- GMAIL TOKENS
-- OAuth tokens stored per client. Refreshed automatically.
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gmail_tokens (
  client_id     UUID PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  access_token  TEXT NOT NULL,
  refresh_token TEXT,
  expiry_date   BIGINT,  -- Unix ms timestamp when access_token expires
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ────────────────────────────────────────────────
-- SESSIONS
-- httpOnly cookie value → client_id mapping. 30-day expiry.
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ────────────────────────────────────────────────
-- BUSINESS PROFILES
-- The AI uses this to draft replies. Populated from the Settings screen.
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_profiles (
  client_id   UUID PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  profile     JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ────────────────────────────────────────────────
-- LEARNED RULES
-- Each row = one edited draft. Fed as few-shot examples into Gemini.
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS learned_rules (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  original_subject TEXT,
  original_body    TEXT,
  edited_reply     TEXT NOT NULL,
  rule_description TEXT,  -- human-readable summary (optional)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ────────────────────────────────────────────────
-- EMAIL CACHE
-- Caches processed emails so we don't re-triage on every page load.
-- Cleared when the client syncs fresh emails.
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_cache (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  gmail_message_id TEXT NOT NULL,
  thread_id       TEXT,
  from_name       TEXT,
  from_email      TEXT,
  subject         TEXT,
  body            TEXT,
  snippet         TEXT,
  received_at     TIMESTAMPTZ,
  category        TEXT CHECK (category IN ('urgent', 'work', 'inbox')),
  draft           TEXT,
  approved        BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(client_id, gmail_message_id)
);

-- Index for fast lookups per client
CREATE INDEX IF NOT EXISTS idx_email_cache_client ON email_cache(client_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
