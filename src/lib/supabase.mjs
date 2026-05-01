// Supabase client voor Pi-runtime.
//
// Pi gebruikt een dedicated auth-user (één per store) i.p.v. een rauwe anon
// key, zodat RLS-policies die op `user_has_store_access(store_id)` checken
// correct werken voor de Pi. De auth-user moet als `store_users` rij gelinkt
// zijn aan de bedoelde store.
//
// Env vars:
//   SUPABASE_URL          — project URL (vereist)
//   SUPABASE_ANON_KEY     — publishable key (vereist)
//   KAIRES_PI_EMAIL       — auth-user email (vereist voor library-mode)
//   KAIRES_PI_PASSWORD    — auth-user password (vereist voor library-mode)
//
// Sessions worden niet op disk gepersisteerd (headless service, geen browser).
// Het SDK-token-refresh mechanisme houdt het JWT zelf ververst zolang het
// proces draait.

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
      autoRefreshToken: true,
      persistSession: false,
      detectSessionInUrl: false,
    },
  }
);

let signedInUserId = null;

/**
 * Signs the runtime in as the configured Pi auth-user. Call once at boot,
 * before any RLS-protected reads/writes (heartbeat, playlist_log, DNA fetch).
 *
 * Returns the user id on success. Throws if creds are missing or rejected.
 */
export async function signIn() {
  if (signedInUserId) return signedInUserId;

  if (!config.pi.email || !config.pi.password) {
    throw new Error(
      'KAIRES_PI_EMAIL en/of KAIRES_PI_PASSWORD ontbreken in .env — ' +
      'Pi-auth user is verplicht voor library-mode (RLS-policies eisen ' +
      'een geldige auth-sessie + store_users membership).'
    );
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email: config.pi.email,
    password: config.pi.password,
  });

  if (error) {
    throw new Error(`Pi-auth signin faalde: ${error.message}`);
  }
  if (!data?.user?.id) {
    throw new Error('Pi-auth signin gaf geen user terug.');
  }

  signedInUserId = data.user.id;
  return signedInUserId;
}

/**
 * Returns the user id from the active session, or null if `signIn()` has
 * not been called yet.
 */
export function getSignedInUserId() {
  return signedInUserId;
}
