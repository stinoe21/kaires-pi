// pi-control-listener — luistert via Supabase realtime op de eigen pi_devices
// rij voor command-intents die de webapp UI heeft gezet (skip / pause).
//
// Conventies:
//   skip_requested_at  — TIMESTAMPTZ. Webapp schrijft now() bij skip. Pi
//                        triggert onSkip wanneer de waarde NIEUWER is dan de
//                        laatst-toegepaste, en clear de kolom na uitvoer
//                        (zodat een tweede skip detecteerbaar is).
//   pause_requested    — BOOLEAN. Webapp schrijft true om te pauzeren,
//                        false om te hervatten. Pi triggert onPause/onPlay
//                        bij elke transitie.
//
// Belt-and-suspenders: net als sonos-listener doen we een 30s-poll als
// fallback voor missed realtime events (kan om netwerkredenen droppen).

import { supabase } from './lib/supabase.mjs';
import { getPiDeviceId } from './pi-device.mjs';

let channel = null;
let pollTimer = null;
let lastAppliedSkipAt = null;
let lastAppliedPauseRequested = false;
let onSkipCb = null;
let onPauseCb = null;
let onPlayCb = null;

function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [pi-control] ${msg}`);
}

async function fetchOwnRow() {
  const id = getPiDeviceId();
  if (!id) return null;
  const { data, error } = await supabase
    .from('pi_devices')
    .select('skip_requested_at, pause_requested')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    log(`fetch faalde: ${error.message}`);
    return null;
  }
  return data;
}

function applyRow(row, reason) {
  if (!row) return;

  // Skip command: trigger als er een skip_requested_at is die nieuwer is
  // dan wat we al gezien hadden.
  const skipAt = row.skip_requested_at ?? null;
  if (skipAt && skipAt !== lastAppliedSkipAt) {
    lastAppliedSkipAt = skipAt;
    log(`Skip-command (${reason}) @ ${skipAt}`);
    if (onSkipCb) {
      Promise.resolve().then(() => onSkipCb()).catch(err => log(`onSkip gooide: ${err.message}`));
    }
  }

  // Pause/play state: alleen op transitie reageren (anders zou elke heartbeat-
  // update ons opnieuw triggeren).
  const paused = !!row.pause_requested;
  if (paused !== lastAppliedPauseRequested) {
    lastAppliedPauseRequested = paused;
    if (paused) {
      log(`Pause-command (${reason})`);
      if (onPauseCb) Promise.resolve().then(() => onPauseCb()).catch(err => log(`onPause gooide: ${err.message}`));
    } else {
      log(`Play-command (${reason})`);
      if (onPlayCb) Promise.resolve().then(() => onPlayCb()).catch(err => log(`onPlay gooide: ${err.message}`));
    }
  }
}

async function syncFromDb(reason) {
  const row = await fetchOwnRow();
  if (row) applyRow(row, reason);
}

/**
 * Subscribe op realtime UPDATEs van de eigen pi_devices rij.
 *
 * @param {Object} cbs
 * @param {Function} cbs.onSkip  — invoked when skip_requested_at advances
 * @param {Function} cbs.onPause — invoked when pause_requested flips true
 * @param {Function} cbs.onPlay  — invoked when pause_requested flips false
 */
export async function startPiControlListener({ onSkip, onPause, onPlay } = {}) {
  onSkipCb = onSkip ?? null;
  onPauseCb = onPause ?? null;
  onPlayCb = onPlay ?? null;

  // Initial sync — set baseline zonder triggers (we beschouwen wat in DB staat
  // bij startup als "al toegepast").
  const initial = await fetchOwnRow();
  if (initial) {
    lastAppliedSkipAt = initial.skip_requested_at ?? null;
    lastAppliedPauseRequested = !!initial.pause_requested;
    log(`Baseline: pause_requested=${lastAppliedPauseRequested}, skip_at=${lastAppliedSkipAt ?? 'null'}`);
    // Als we starten met pause_requested=true, willen we wél meteen onPause
    // triggeren zodat de pulse loop meteen idle gaat.
    if (lastAppliedPauseRequested && onPauseCb) {
      Promise.resolve().then(() => onPauseCb()).catch(err => log(`initial onPause gooide: ${err.message}`));
    }
  }

  const id = getPiDeviceId();
  if (!id) {
    log('Geen pi-device id — listener niet gestart');
    return;
  }

  channel = supabase
    .channel(`pi_devices:${id}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'pi_devices',
        filter: `id=eq.${id}`,
      },
      (payload) => applyRow(payload.new, 'realtime'),
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') log('Realtime channel SUBSCRIBED');
      if (status === 'CHANNEL_ERROR') log('Realtime channel error — fallback poll dekt commands');
      if (status === 'CLOSED') log('Realtime channel CLOSED');
    });

  pollTimer = setInterval(() => { void syncFromDb('poll'); }, 30_000);
}

export async function stopPiControlListener() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (channel) {
    await supabase.removeChannel(channel).catch(() => {});
    channel = null;
  }
}
