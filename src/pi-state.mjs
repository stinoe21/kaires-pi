// pi-state — schrijft de "now playing"-state van deze Pi naar `pi_devices`
// zodat het webapp-dashboard live kan tonen wat er speelt (zelfde
// LibraryPlayer-UI als in webapp-mode, maar gevoed vanuit DB i.p.v. een
// browser <audio> element).
//
// Schrijfsnelheid: alleen op state-overgangen (idle → connecting → playing →
// idle) — de progress-bar wordt webapp-side berekend uit (now - started_at)
// zodat we niet elke seconde naar de DB pinken.

import { supabase } from './lib/supabase.mjs';
import { getPiDeviceId } from './pi-device.mjs';

function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [pi-state] ${msg}`);
}

async function writeRow(patch) {
  const id = getPiDeviceId();
  if (!id) return; // pi-device nog niet geregistreerd
  const { error } = await supabase
    .from('pi_devices')
    .update(patch)
    .eq('id', id);
  if (error) log(`update faalde: ${error.message}`);
}

/**
 * Pi heeft een speaker-target gekozen maar audio is nog niet bevestigd
 * playing. Dashboard toont "loading…" in plaats van een leeg vinyl.
 */
export async function setConnecting(track) {
  await writeRow({
    playback_state: 'connecting',
    current_track_id: track?.id ?? null,
    current_track_title: track?.title ?? null,
    current_track_artist: track?.artist ?? null,
    current_track_started_at: null,
    current_track_duration_ms: track?.duration_ms ?? null,
    current_track_cas: track?.cas ?? null,
  });
}

/**
 * Pi bevestigt actieve playback. Webapp gebruikt `current_track_started_at`
 * om de progress-bar lokaal te animeren (geen DB-spam per seconde).
 */
export async function setNowPlaying(track) {
  await writeRow({
    playback_state: 'playing',
    current_track_id: track?.id ?? null,
    current_track_title: track?.title ?? null,
    current_track_artist: track?.artist ?? null,
    current_track_started_at: new Date().toISOString(),
    current_track_duration_ms: track?.duration_ms ?? null,
    current_track_cas: track?.cas ?? null,
  });
}

/**
 * Operator/klant pauzeerde via dashboard. We laten de current_track_*-velden
 * staan zodat de UI nog laat zien WAT er gepauzeerd is.
 */
export async function setPaused() {
  await writeRow({ playback_state: 'paused' });
}

/**
 * Geen actieve track (track ended / no target / startup). UI toont leeg
 * vinyl + "Loading…".
 */
export async function setIdle() {
  await writeRow({
    playback_state: 'idle',
    current_track_id: null,
    current_track_title: null,
    current_track_artist: null,
    current_track_started_at: null,
    current_track_duration_ms: null,
    current_track_cas: null,
  });
}

/**
 * Bij skip-command: clear `skip_requested_at` zodat we 'm later opnieuw
 * kunnen detecteren als de operator nog een keer skipt. Idem voor
 * pause-acks (we schrijven playback_state, niet pause_requested terug,
 * pause_requested is door de webapp gezet en blijft staan tot die 'm clear).
 */
export async function clearSkipRequest() {
  await writeRow({ skip_requested_at: null });
}
