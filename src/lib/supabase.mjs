// Supabase client voor Pi-runtime.
// Geen browser-auth, geen session-persistence, geen localStorage — Pi draait
// als headless service met alleen anon key. RLS-rules op de tabellen
// (tracks/realtime_context/retailer_music_dna/playlist_log/pilot_heartbeat)
// moeten public-read of public-insert zijn waar nodig.

import { createClient } from '@supabase/supabase-js';
import { config } from '../config.mjs';

if (!config.supabase.url || !config.supabase.anonKey) {
  throw new Error(
    'Supabase config ontbreekt — vul SUPABASE_URL en SUPABASE_ANON_KEY in .env'
  );
}

export const supabase = createClient(
  config.supabase.url,
  config.supabase.anonKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  }
);
