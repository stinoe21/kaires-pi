// Sonos output adapter — UPnP via npm `sonos`.
// Verantwoordelijk voor: connectie naar de actieve speaker, coordinator-detectie,
// play, end-detection, en hot-switch wanneer het webapp-dashboard de
// `is_active_output`-flag verzet. Geen weet van CAS, library, of curatie.
//
// Speaker-keuze:
//   1. setTargetSpeaker(speaker)  — gezet door sonos-listener bij elke flip
//   2. config.sonos.hintIp        — fallback voor situaties zonder DB-flag
//      (lokale dev, geen Supabase, of speakers nog niet gepubliceerd)
//   3. SSDP "first responder"     — last-resort, ongedefinieerd welke speaker

import { DeviceDiscovery, Sonos } from 'sonos';
import { config } from './config.mjs';

const SSDP_TIMEOUT_MS = 10_000;

let coordinator = null;
let currentTargetIp = null;

function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [sonos] ${msg}`);
}

async function ssdpFirstDevice() {
  return new Promise((resolve, reject) => {
    log(`SSDP scan (max ${SSDP_TIMEOUT_MS / 1000}s)...`);
    const discovery = DeviceDiscovery({ timeout: SSDP_TIMEOUT_MS });
    let resolved = false;
    discovery.once('DeviceAvailable', (device) => {
      if (resolved) return;
      resolved = true;
      try { discovery.destroy?.(); } catch {}
      log(`Eerste device: ${device.host}`);
      resolve(device);
    });
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { discovery.destroy?.(); } catch {}
      reject(new Error('Geen Sonos gevonden binnen SSDP-timeout'));
    }, SSDP_TIMEOUT_MS);
  });
}

async function findCoordinator(device) {
  // De groep-coordinator is het device dat audio synchroon naar volgers verdeelt.
  // Stuur altijd naar coordinator, anders krijg je split-state in de zone.
  try {
    const groups = await device.getAllGroups();
    for (const group of groups) {
      const inThisGroup = (group.ZoneGroupMember ?? [])
        .some(m => m.Location?.includes(device.host));
      if (inThisGroup) {
        const coordHost = group.host ?? group.CoordinatorIPAddress;
        if (coordHost && coordHost !== device.host) {
          log(`Coordinator is ${coordHost} (niet ${device.host})`);
          return new Sonos(coordHost);
        }
        return device;
      }
    }
  } catch (err) {
    log(`Coordinator-lookup faalde, val terug op direct device: ${err.message}`);
  }
  return device;
}

async function connectToIp(ip) {
  const device = new Sonos(ip);
  const coord = await findCoordinator(device);
  const attrs = await coord.getZoneAttrs().catch(() => ({}));
  log(`Verbonden met room "${attrs.CurrentZoneName ?? '?'}" op ${coord.host}`);
  return coord;
}

/**
 * Initiële connectie. Als noch setTargetSpeaker() noch hintIp gezet is,
 * gooien we — er is geen zinvol target. De runtime moet dan de listener
 * eerst draaien zodat de DB-target binnenkomt.
 */
export async function connect() {
  if (coordinator) return coordinator;

  if (currentTargetIp) {
    coordinator = await connectToIp(currentTargetIp);
    return coordinator;
  }

  if (config.sonos.hintIp) {
    log(`Verbinden via hint IP ${config.sonos.hintIp} (DB-target nog niet bekend)`);
    coordinator = await connectToIp(config.sonos.hintIp);
    currentTargetIp = config.sonos.hintIp;
    return coordinator;
  }

  log('Geen target gezet en geen hint IP — wacht op DB-target via sonos-listener');
  // Niet hard falen — runtime mag idle blijven tot operator een speaker kiest.
  return null;
}

/**
 * Verzet het output-target naar een nieuwe Sonos. Stop eerst de huidige
 * playback om dubbele audio te voorkomen tussen oud en nieuw target.
 */
export async function setTargetSpeaker(speaker) {
  // null/undefined = "geen actieve speaker" — runtime moet idle.
  const nextIp = speaker?.ip_address ?? null;
  if (nextIp === currentTargetIp) return;

  if (coordinator) {
    try { await coordinator.stop(); } catch {}
  }

  if (!nextIp) {
    log('Target-clear — Pi gaat idle');
    coordinator = null;
    currentTargetIp = null;
    return;
  }

  log(`Switch target → ${speaker.room_name} @ ${nextIp}`);
  currentTargetIp = nextIp;
  coordinator = await connectToIp(nextIp);
}

export function hasTarget() {
  return !!coordinator;
}

export async function play(url) {
  if (!coordinator) {
    throw new Error('Geen actieve Sonos-speaker — kies een speaker in het dashboard');
  }
  log(`Play: ${url}`);
  await coordinator.play(url);
}

export async function stop() {
  if (!coordinator) return;
  await coordinator.stop().catch(err => log(`stop() faalde: ${err.message}`));
}

export async function getState() {
  if (!coordinator) return 'disconnected';
  return coordinator.getCurrentState().catch(() => 'unknown');
}

// Wacht tot de huidige track stopt (natuurlijk eindigt of extern gepauzeerd).
// Polled elke pollMs ms. Returns de eindstate ('stopped' | 'paused' | 'timeout').
export async function waitUntilEnded({ maxMs = 600_000, pollMs = config.trackEndPollMs } = {}) {
  if (!coordinator) throw new Error('Niet verbonden');
  const startedAt = Date.now();
  let lastState = null;

  while (true) {
    const elapsed = Date.now() - startedAt;
    if (elapsed > maxMs) {
      log(`Track-end timeout na ${(elapsed / 1000).toFixed(0)}s — stop forceren`);
      await stop();
      return 'timeout';
    }
    const state = await getState();
    if (state !== lastState) {
      log(`Transport state: ${state}`);
      lastState = state;
    }
    if (state === 'stopped' || state === 'paused') {
      return state;
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
}
