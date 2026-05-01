// sonos-listener — luistert via Supabase realtime op `sonos_speakers` voor
// deze store. Wanneer de operator/klant in het webapp-dashboard een vinkje
// verzet, krijgt de Pi binnen seconden een UPDATE-event en switcht zijn
// UPnP-target.
//
// We doen óók één initiele fetch zodat de Pi bij startup direct weet welke
// speaker actief zou moeten zijn — anders zou je moeten wachten tot iemand
// het vinkje opnieuw klikt.

import { supabase } from './lib/supabase.mjs';
import { config } from './config.mjs';

let activeSpeaker = null;
let onChangeCallback = null;
let channel = null;

function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [sonos-listener] ${msg}`);
}

/**
 * Returns the speaker row currently flagged as `is_active_output = true`
 * for our store. Picks the most-recently-updated one if (incorrectly)
 * multiple are active at once.
 */
async function fetchActive() {
  const { data, error } = await supabase
    .from('sonos_speakers')
    .select('id, room_name, ip_address, sonos_uuid')
    .eq('store_id', config.store.id)
    .eq('is_active_output', true)
    .order('last_seen_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    log(`Active-fetch faalde: ${error.message}`);
    return null;
  }
  return data;
}

function isSameSpeaker(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.id === b.id && a.ip_address === b.ip_address;
}

async function syncFromDb(reason) {
  const next = await fetchActive();
  if (isSameSpeaker(activeSpeaker, next)) return;
  const previous = activeSpeaker;
  activeSpeaker = next;
  if (next) {
    log(`Active speaker (${reason}): ${next.room_name} @ ${next.ip_address}`);
  } else {
    log(`Geen active speaker (${reason}) — Pi blijft idle`);
  }
  if (onChangeCallback) {
    try {
      await onChangeCallback(next, previous);
    } catch (err) {
      log(`onChange-callback gooide: ${err.message}`);
    }
  }
}

/**
 * Subscribe op realtime updates van sonos_speakers voor deze store. Het
 * `onChange` callback wordt zowel bij startup-sync als bij elke flip aangeroepen,
 * zodat de output-adapter consistent kan reageren.
 */
export async function startSonosListener({ onChange }) {
  onChangeCallback = onChange ?? null;

  // Initial sync — onChange() krijgt eerste-keer-trigger.
  await syncFromDb('initial');

  channel = supabase
    .channel(`sonos_speakers:${config.store.id}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'sonos_speakers',
        filter: `store_id=eq.${config.store.id}`,
      },
      () => { void syncFromDb('realtime'); },
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') log('Realtime channel SUBSCRIBED');
      if (status === 'CHANNEL_ERROR') log('Realtime channel error — flips komen pas bij periodieke fallback-sync');
      if (status === 'CLOSED') log('Realtime channel CLOSED');
    });

  // Belt-and-suspenders: realtime SUBSCRIBED is in de huidige Pi-setup vaak
  // niet stabiel, dus de poll is in de praktijk de primaire trigger. 2s
  // houdt speaker-switch-feedback quasi-direct; per store 1 SELECT op een
  // kleine indexed query — DB-load verwaarloosbaar.
  setInterval(() => { void syncFromDb('poll'); }, 2_000);
}

export async function stopSonosListener() {
  if (channel) {
    await supabase.removeChannel(channel).catch(() => {});
    channel = null;
  }
}

export function getActiveSpeaker() {
  return activeSpeaker;
}
