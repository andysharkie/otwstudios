// lib/db.js — Supabase client (server-side only, uses service key)
import { createClient } from '@supabase/supabase-js';

let _client = null;

export function getDb() {
  if (!_client) {
    const url  = process.env.SUPABASE_URL;
    const key  = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars');
    _client = createClient(url, key, {
      auth: { persistSession: false },
    });
  }
  return _client;
}
