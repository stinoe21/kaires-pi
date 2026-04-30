// Sonos output adapter — UPnP via npm `sonos`.
// Verantwoordelijk voor: discovery, coordinator-detectie, play, end-detection.
// Geen weet van CAS, library, of curatie — pure transport-laag.

import { DeviceDiscovery, Sonos } from 'sonos';
import { config } from './config.mjs';

const SSDP_TIMEOUT_MS = 10_000;

let coordinator = null;

function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [sonos] ${msg}`);
}

async function discoverDevice() {
  if (config.sonos.hintIp) {
    log(`Verbinden via hint IP ${config.sonos.hintIp}`);
    return new Sonos(config.sonos.hintIp);
  }
  return new Promise((resolve, reject) => {
    log(`SSDP scan (max ${SSDP_TIMEOUT_MS / 1000}s)...`);
    const discovery = DeviceDiscovery({ timeout: SSDP_TIMEOUT_MS });
    let resolved = false;
    discovery.once('DeviceAvailable', (device) => {
      if (resolved) return;
      resolved = true;
      discovery.destroy?.();
      log(`Eerste device: ${device.host}`);
      resolve(device);
    });
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      discovery.destroy?.();
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

export async function connect() {
  if (coordinator) return coordinator;
  const device = await discoverDevice();
  coordinator = await findCoordinator(device);
  const attrs = await coordinator.getZoneAttrs();
  log(`Verbonden met room "${attrs.CurrentZoneName}" op ${coordinator.host}`);
  return coordinator;
}

export async function play(url) {
  if (!coordinator) await connect();
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
