// Heartbeat — schrijft elke heartbeatIntervalMs ms een rij naar pilot_heartbeat
// zodat het admin-dashboard ziet dat de Pi leeft. Provider='pi' onderscheidt
// Pi-heartbeats van iPad-heartbeats.
//
// Geport van services/heartbeat.ts. Vereenvoudigingen:
// - Geen telemetry-error capture (komt in 2c)
// - Geen MIN_INTERVAL_MS guard — wordt al door setInterval afgedwongen
// - Geen user_id — Pi heeft geen logged-in user
// - User-agent → hostname
// - Disable-on-table-missing logic behouden

import { hostname } from 'node:os';
import { supabase, getSignedInUserId } from './lib/supabase.mjs';
import { config } from './config.mjs';

const HOST = hostname();

let timer = null;
let disabled = false;
let pulseCount = 0;
let lastTrackId = null;

function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [heartbeat] ${msg}`);
}

export function setLastTrackId(id) {
  lastTrackId = id;
}

export function incrementPulse() {
  pulseCount += 1;
}

async function sendHeartbeat() {
  if (disabled) return;
  try {
    const { error } = await supabase.from('pilot_heartbeat').insert({
      store_id: config.store.id ?? null,
      user_id: getSignedInUserId(),       // Pi-auth user — vereist voor RLS
      provider: 'pi',
      source: 'pi',                       // sluit aan op stores.playback_source
      is_foreground: true,                // Pi draait als service, altijd "actief"
      agent_enabled: true,
      last_track_id: lastTrackId,
      pulse_count: pulseCount,
      user_agent: `kaires-pi/${config.appVersion} ${HOST}`.slice(0, 200),
      app_version: config.appVersion,
      online: true,
      last_error_at: null,
      last_error_msg: null,
    });
    if (error) {
      if (error.code === '42P01' || /does not exist/i.test(error.message ?? '')) {
        log('Tabel pilot_heartbeat ontbreekt — disable heartbeat (run migrations)');
        disabled = true;
      } else {
        log(`Insert faalde (non-blocking): ${error.message}`);
      }
    }
  } catch (err) {
    log(`Onverwachte fout: ${err.message}`);
  }
}

export function startHeartbeat() {
  if (timer) return;
  log(`Start (${config.heartbeatIntervalMs / 1000}s interval, host=${HOST})`);
  // Eerste tik direct, niet pas na interval
  void sendHeartbeat();
  timer = setInterval(sendHeartbeat, config.heartbeatIntervalMs);
}

export function stopHeartbeat() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  log('Gestopt');
}
