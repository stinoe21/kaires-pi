// store-listener — luistert op `stores.playback_source` voor deze store en
// laat de runtime weten wanneer audio NIET via deze Pi geroutet moet worden.
//
// Operator/klant kan in het dashboard van Kai-Box terug naar Webapp toggelen.
// Dat flipt `stores.playback_source = 'webapp'` — vanaf dat moment moet de Pi
// stoppen met afspelen op de Sonos (anders speelt audio dubbel: in de browser
// EN op de speaker). Symmetrisch: wanneer source weer 'pi' wordt, moet de Pi
// auto-resumen.
//
// Belt-and-suspenders 2s-poll, gelijk aan pi-control-listener; realtime
// SUBSCRIBED is in de huidige setup niet betrouwbaar.

import { supabase } from './lib/supabase.mjs';
import { config } from './config.mjs';

let channel = null;
let pollTimer = null;
let lastApplied = null; // 'pi' | 'webapp' | null
let onChangeCb = null;

function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [store-listener] ${msg}`);
}

async function fetchOwn() {
  const { data, error } = await supabase
    .from('stores')
    .select('playback_source')
    .eq('id', config.store.id)
    .maybeSingle();
  if (error) {
    log(`fetch faalde: ${error.message}`);
    return null;
  }
  return data?.playback_source ?? null;
}

function applySource(source, reason) {
  if (source === lastApplied) return;
  const previous = lastApplied;
  lastApplied = source;
  log(`playback_source ${previous ?? 'null'} → ${source ?? 'null'} (${reason})`);
  if (onChangeCb) {
    Promise.resolve()
      .then(() => onChangeCb(source, previous))
      .catch(err => log(`onChange gooide: ${err.message}`));
  }
}

async function syncFromDb(reason) {
  const source = await fetchOwn();
  if (source !== null) applySource(source, reason);
}

/**
 * Subscribe op stores.playback_source voor deze store.
 *
 * @param {Object} cbs
 * @param {(next: string|null, previous: string|null) => Promise<void>|void} cbs.onChange
 *   Wordt op state-overgang aangeroepen. Initial sync triggert óók wanneer er
 *   een waarde uit DB komt — zodat de runtime bij startup direct weet of 'ie
 *   actief moet zijn (source='pi') of idle moet blijven.
 */
export async function startStoreListener({ onChange } = {}) {
  onChangeCb = onChange ?? null;

  await syncFromDb('initial');

  channel = supabase
    .channel(`stores:${config.store.id}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'stores',
        filter: `id=eq.${config.store.id}`,
      },
      (payload) => {
        const next = payload.new?.playback_source ?? null;
        if (next !== null) applySource(next, 'realtime');
      },
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') log('Realtime channel SUBSCRIBED');
      if (status === 'CHANNEL_ERROR') log('Realtime channel error — fallback poll dekt routing-flips');
      if (status === 'CLOSED') log('Realtime channel CLOSED');
    });

  pollTimer = setInterval(() => { void syncFromDb('poll'); }, 2_000);
}

export async function stopStoreListener() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (channel) {
    await supabase.removeChannel(channel).catch(() => {});
    channel = null;
  }
}

export function getCurrentSource() {
  return lastApplied;
}
