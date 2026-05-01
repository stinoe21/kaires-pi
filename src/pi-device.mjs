// pi-device — schrijft één rij in `pi_devices` per Pi op startup + houdt
// `last_seen_at` actueel zolang de runtime draait.
//
// Het webapp-dashboard leest deze tabel om te bepalen of er een Pi voor de
// store is geregistreerd, en toont de Audio-Output panel pas wanneer er een
// row staat met een verse `last_seen_at` (< 90s).
//
// Uniqueness: (store_id, device_name). Eén Pi per (store, hostname) — als je
// twee Pi's met dezelfde hostname onder één store wilt zou dat eerst de
// device_name moeten unieken. Voor nu prima.

import { hostname, networkInterfaces } from 'node:os';
import { supabase } from './lib/supabase.mjs';
import { config } from './config.mjs';

let cachedDeviceId = null;
let touchTimer = null;

const HOSTNAME = hostname();
const DEVICE_NAME = (process.env.KAIRES_DEVICE_NAME || HOSTNAME).slice(0, 100);

function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [pi-device] ${msg}`);
}

/**
 * Best-effort: vind het primary IPv4 adres van de Pi op het lokale netwerk.
 * Skipped: loopback (127.x), link-local (169.254.x), Docker bridges (172.x).
 */
function detectIpAddress() {
  for (const iface of Object.values(networkInterfaces())) {
    for (const addr of iface ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (addr.address.startsWith('127.')) continue;
      if (addr.address.startsWith('169.254.')) continue;
      if (addr.address.startsWith('172.17.') || addr.address.startsWith('172.18.')) continue;
      return addr.address;
    }
  }
  return null;
}

/**
 * Upsert the pi_devices row for this runtime. Returns the row id, which
 * sonos-discovery uses as the FK on sonos_speakers.
 */
export async function registerPiDevice() {
  if (cachedDeviceId) return cachedDeviceId;

  const ip = detectIpAddress();
  const payload = {
    store_id: config.store.id,
    device_name: DEVICE_NAME,
    hostname: HOSTNAME,
    ip_address: ip,
    software_version: `kaires-pi/${config.appVersion}`,
    last_seen_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('pi_devices')
    .upsert(payload, { onConflict: 'store_id,device_name' })
    .select('id')
    .single();

  if (error) {
    throw new Error(`pi_devices upsert faalde: ${error.message}`);
  }

  cachedDeviceId = data.id;
  log(`Geregistreerd als ${DEVICE_NAME} (id ${cachedDeviceId.slice(0, 8)}…) op ${ip ?? 'unknown-ip'}`);
  return cachedDeviceId;
}

/**
 * Update `last_seen_at` so the dashboard shows the Pi as online. Called every
 * heartbeat-tick (30s); kept separate from `pi_devices` upsert so we don't
 * re-write hostname/ip every 30s for no reason.
 */
async function touch() {
  if (!cachedDeviceId) return;
  const { error } = await supabase
    .from('pi_devices')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', cachedDeviceId);
  if (error) log(`touch faalde (non-blocking): ${error.message}`);
}

export function startTouchInterval() {
  if (touchTimer) return;
  touchTimer = setInterval(() => { void touch(); }, config.heartbeatIntervalMs);
}

export function stopTouchInterval() {
  if (!touchTimer) return;
  clearInterval(touchTimer);
  touchTimer = null;
}

export function getPiDeviceId() {
  return cachedDeviceId;
}
