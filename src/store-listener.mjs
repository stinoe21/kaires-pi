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
let lastSource = null; // 'pi' | 'webapp' | null
let lastSchedule = undefined; // undefined = nooit gefetched; null = expliciet "geen schedule"
let lastTimezone = null;
let onChangeCb = null;
let onScheduleChangeCb = null;

function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [store-listener] ${msg}`);
}

async function fetchOwn() {
  const { data, error } = await supabase
    .from('stores')
    .select('playback_source, opening_schedule, timezone')
    .eq('id', config.store.id)
    .maybeSingle();
  if (error) {
    log(`fetch faalde: ${error.message}`);
    return null;
  }
  return data;
}

function scheduleEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  // Cheap structural check — opening_schedule is small (max ~7 days × few slots).
  return JSON.stringify(a) === JSON.stringify(b);
}

function applySource(source, reason) {
  if (source === lastSource) return;
  const previous = lastSource;
  lastSource = source;
  log(`playback_source ${previous ?? 'null'} → ${source ?? 'null'} (${reason})`);
  if (onChangeCb) {
    Promise.resolve()
      .then(() => onChangeCb(source, previous))
      .catch(err => log(`onChange gooide: ${err.message}`));
  }
}

function applySchedule(schedule, reason) {
  // First fetch always counts as a change (lastSchedule starts undefined).
  if (lastSchedule !== undefined && scheduleEqual(schedule, lastSchedule)) return;
  const previous = lastSchedule;
  lastSchedule = schedule;
  if (schedule == null) {
    log(`opening_schedule ontbreekt — Pi blijft 24/7 actief (${reason})`);
  } else {
    const dayCount = Object.values(schedule).filter(d => d?.enabled).length;
    log(`opening_schedule: ${dayCount} open dag(en) (${reason})`);
  }
  if (onScheduleChangeCb) {
    Promise.resolve()
      .then(() => onScheduleChangeCb(schedule, previous))
      .catch(err => log(`onScheduleChange gooide: ${err.message}`));
  }
}

async function syncFromDb(reason) {
  const row = await fetchOwn();
  if (!row) return;
  if (row.playback_source !== null && row.playback_source !== undefined) {
    applySource(row.playback_source, reason);
  }
  // opening_schedule mag null zijn — dat is een geldige "geen rooster"-state.
  applySchedule(row.opening_schedule ?? null, reason);
  // Timezone: stil cachen, geen log. Verandert in de praktijk nooit.
  if (typeof row.timezone === 'string' && row.timezone) {
    lastTimezone = row.timezone;
  }
}

/**
 * Subscribe op stores.playback_source + stores.opening_schedule voor deze store.
 *
 * @param {Object} cbs
 * @param {(next: string|null, previous: string|null) => Promise<void>|void} cbs.onChange
 *   playback_source state-overgang. Initial sync triggert óók wanneer er een
 *   waarde uit DB komt — zodat de runtime bij startup direct weet of 'ie actief
 *   moet zijn (source='pi') of idle moet blijven.
 * @param {(next: object|null, previous: object|null|undefined) => Promise<void>|void} cbs.onScheduleChange
 *   opening_schedule state-overgang. Eerste sync vuurt ook (previous = undefined).
 *   `null` = geen rooster geconfigureerd → 24/7 open (backwards-compat).
 */
export async function startStoreListener({ onChange, onScheduleChange } = {}) {
  onChangeCb = onChange ?? null;
  onScheduleChangeCb = onScheduleChange ?? null;

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
        const row = payload.new ?? {};
        if (row.playback_source != null) applySource(row.playback_source, 'realtime');
        // opening_schedule kan null zijn — apply ook bij null-payloads.
        if ('opening_schedule' in row) applySchedule(row.opening_schedule ?? null, 'realtime');
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
  return lastSource;
}

export function getCurrentOpeningSchedule() {
  return lastSchedule === undefined ? null : lastSchedule;
}

export function getCurrentTimezone() {
  return lastTimezone || 'Europe/Amsterdam';
}
