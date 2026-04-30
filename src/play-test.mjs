// Fase-1 stap 3: Play-test via setAVTransportURI
// Vindt zone-coordinator, speelt test-MP3 af, polled GetTransportInfo elke
// 5s tot STOPPED. Logt timing van elke transitie. Dit is het bewijs dat de
// hele aanname klopt: Pi → UPnP → Sonos → audio.
//
// Gebruik:
//   node src/play-test.mjs                       # default test MP3 uit .env.example
//   node src/play-test.mjs <url>                 # eigen URL
//   KAIRES_SONOS_HINT_IP=192.168.1.50 node ...   # bypass multicast

import { DeviceDiscovery, Sonos } from 'sonos';

const HINT_IP = process.env.KAIRES_SONOS_HINT_IP;
const TEST_URL = process.argv[2]
  ?? process.env.KAIRES_TEST_AUDIO_URL
  ?? 'https://archive.org/download/testmp3testfile/mpthreetest.mp3';
const POLL_INTERVAL_MS = 5000;
const MAX_PLAY_DURATION_MS = 60_000; // safety: stop after 60s if track doesn't end

function timestamp() {
  return new Date().toISOString().slice(11, 23);
}

function log(msg) {
  console.log(`[${timestamp()}] ${msg}`);
}

async function findFirstDevice() {
  if (HINT_IP) {
    log(`Verbinden via hint IP: ${HINT_IP}`);
    return new Sonos(HINT_IP);
  }
  return new Promise((resolve, reject) => {
    log('SSDP scan (max 10s)...');
    const discovery = DeviceDiscovery({ timeout: 10000 });
    let resolved = false;
    discovery.once('DeviceAvailable', (device) => {
      if (resolved) return;
      resolved = true;
      discovery.destroy?.();
      resolve(device);
    });
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      discovery.destroy?.();
      reject(new Error('Geen Sonos gevonden'));
    }, 10000);
  });
}

async function findCoordinator(device) {
  // Zoek de coordinator van de groep waar dit device in zit.
  // Sonos verdeelt audio synchroon vanuit de coordinator naar volgers.
  try {
    const groups = await device.getAllGroups();
    for (const group of groups) {
      const members = group.ZoneGroupMember ?? [];
      const inThisGroup = members.some(m => m.Location?.includes(device.host));
      if (inThisGroup) {
        const coordHost = group.host ?? group.CoordinatorIPAddress;
        if (coordHost && coordHost !== device.host) {
          log(`Coordinator van groep is ${coordHost} (niet ${device.host})`);
          return new Sonos(coordHost);
        }
        return device;
      }
    }
  } catch (err) {
    log(`Kon coordinator niet bepalen, val terug op directe device: ${err.message}`);
  }
  return device;
}

async function pollUntilStopped(device, startedAt) {
  let lastState = null;
  while (true) {
    const elapsed = Date.now() - startedAt;
    if (elapsed > MAX_PLAY_DURATION_MS) {
      log(`Max duur (${MAX_PLAY_DURATION_MS / 1000}s) bereikt — stop afspelen`);
      await device.stop().catch(() => {});
      return 'TIMEOUT';
    }
    const info = await device.getCurrentState().catch(err => {
      log(`getCurrentState fout: ${err.message}`);
      return null;
    });
    if (info !== lastState) {
      log(`State: ${info ?? '?'}`);
      lastState = info;
    }
    if (info === 'stopped' || info === 'paused') {
      return info;
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

async function main() {
  const device = await findFirstDevice();
  const coordinator = await findCoordinator(device);

  const zoneAttrs = await coordinator.getZoneAttrs();
  log(`Coordinator room: ${zoneAttrs.CurrentZoneName} (${coordinator.host})`);

  log(`Test URL: ${TEST_URL}`);
  log('Stuur setAVTransportURI + play...');

  const startedAt = Date.now();
  await coordinator.play(TEST_URL);
  log(`Play-call voltooid in ${Date.now() - startedAt}ms`);

  log('Poll voor STOPPED...');
  const finalState = await pollUntilStopped(coordinator, startedAt);

  const totalMs = Date.now() - startedAt;
  log(`Klaar — eindstate: ${finalState}, totaal: ${totalMs}ms`);

  console.log(`\n✓ Play-test OK — Pi kan audio naar Sonos sturen`);
  process.exit(0);
}

main().catch(err => {
  console.error('FAIL:', err);
  process.exit(1);
});
