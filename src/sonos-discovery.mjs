// sonos-discovery — vindt alle Sonos-speakers in het LAN via SSDP en
// publiceert ze in de `sonos_speakers`-tabel. Het webapp-dashboard toont
// die lijst zodat de operator/klant via een checkbox kan kiezen waar de
// Pi de audio naartoe pusht.
//
// Discovery loopt:
//   - Eénmaal bij startup (zo snel mogelijk zodat de UI niet leeg blijft)
//   - Periodiek elke 5 minuten (om verplaatste of nieuwe speakers op te pikken)
//
// Idempotent: schrijft via upsert (pi_id, sonos_uuid) — herhaalde discovery
// updatet alleen de last_seen_at en eventueel veranderde room/IP-velden.

import { DeviceDiscovery } from 'sonos';
import { supabase } from './lib/supabase.mjs';
import { config } from './config.mjs';
import { getPiDeviceId } from './pi-device.mjs';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const SCAN_TIMEOUT_MS = 8_000;

let refreshTimer = null;

function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [sonos-discovery] ${msg}`);
}

/**
 * Scan the LAN voor Sonos devices en retourneer een Map<host, deviceObject>.
 * Niet alle modellen reageren op één SSDP-burst; we wachten de hele
 * SCAN_TIMEOUT_MS uit zodat we een volledige snapshot krijgen.
 */
async function scan() {
  return new Promise((resolve) => {
    const seen = new Map();
    const discovery = DeviceDiscovery({ timeout: SCAN_TIMEOUT_MS });
    discovery.on('DeviceAvailable', (device) => {
      if (!seen.has(device.host)) seen.set(device.host, device);
    });
    setTimeout(() => {
      try { discovery.destroy?.(); } catch { /* sonos pkg occasionally dgram-races */ }
      resolve(seen);
    }, SCAN_TIMEOUT_MS);
  });
}

/**
 * Verzamelt voor één Sonos-device de velden die de webapp UI nodig heeft.
 * Failures op één device falen niet de hele discovery.
 */
async function describe(device) {
  try {
    const desc = await device.deviceDescription();
    const zoneAttrs = await device.getZoneAttrs().catch(() => ({}));

    let groupCoordinatorUuid = null;
    try {
      const groups = await device.getAllGroups();
      for (const g of groups) {
        const inThisGroup = (g.ZoneGroupMember ?? [])
          .some(m => m.Location?.includes(device.host));
        if (inThisGroup) {
          groupCoordinatorUuid = g.Coordinator ?? null;
          break;
        }
      }
    } catch { /* zone-info is non-fatal */ }

    return {
      sonos_uuid: desc.UDN ?? `unknown-${device.host}`,
      room_name: zoneAttrs.CurrentZoneName ?? desc.roomName ?? device.host,
      ip_address: device.host,
      model: desc.modelName ?? null,
      group_coordinator_uuid: groupCoordinatorUuid,
    };
  } catch (err) {
    log(`Describe ${device.host} faalde: ${err.message}`);
    return null;
  }
}

/**
 * Run één discovery-cycle: scan + persist. Wordt vanaf startup aangeroepen
 * en daarna periodiek. Geen exception naar buiten — discovery is best-effort.
 */
async function runCycle() {
  const piId = getPiDeviceId();
  if (!piId) {
    log('Pi-device nog niet geregistreerd — skip cycle');
    return;
  }

  let devices;
  try {
    devices = await scan();
  } catch (err) {
    log(`SSDP-scan faalde: ${err.message}`);
    return;
  }

  if (devices.size === 0) {
    log('Geen Sonos-speakers gevonden op het LAN');
    return;
  }

  const now = new Date().toISOString();
  const rows = [];
  for (const device of devices.values()) {
    const fields = await describe(device);
    if (!fields) continue;
    rows.push({
      pi_id: piId,
      store_id: config.store.id,
      ...fields,
      last_seen_at: now,
    });
  }

  if (rows.length === 0) {
    log('Discovery vond devices maar geen describe-data — skip upsert');
    return;
  }

  const { error } = await supabase
    .from('sonos_speakers')
    .upsert(rows, { onConflict: 'pi_id,sonos_uuid', ignoreDuplicates: false });

  if (error) {
    log(`Upsert faalde: ${error.message}`);
    return;
  }

  log(`${rows.length} speaker(s) gepubliceerd: ${rows.map(r => r.room_name).join(', ')}`);
}

export async function startSonosDiscovery() {
  if (refreshTimer) return;
  log('Eerste discovery-scan...');
  await runCycle();
  refreshTimer = setInterval(() => { void runCycle(); }, REFRESH_INTERVAL_MS);
}

export function stopSonosDiscovery() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
