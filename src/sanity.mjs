// Fase-1 stap 2: Sanity-check via volume control
// Vindt eerste Sonos device, leest huidig volume, zet 'm op 20, leest terug,
// herstelt origineel. Bewijst dat we kunnen praten met het device zonder
// muziek af te spelen (veilige test in productie-omgeving).
//
// Gebruik:
//   node src/sanity.mjs
//   KAIRES_SONOS_HINT_IP=192.168.1.50 node src/sanity.mjs

import { DeviceDiscovery, Sonos } from 'sonos';

const HINT_IP = process.env.KAIRES_SONOS_HINT_IP;
const TEST_VOLUME = 20;

async function findFirstDevice(timeoutMs = 10000) {
  if (HINT_IP) {
    console.log(`Verbinden via hint IP: ${HINT_IP}`);
    return new Sonos(HINT_IP);
  }
  return new Promise((resolve, reject) => {
    console.log('SSDP scan (max 10s)...');
    const discovery = DeviceDiscovery({ timeout: timeoutMs });
    let resolved = false;
    discovery.once('DeviceAvailable', (device) => {
      if (resolved) return;
      resolved = true;
      console.log(`Eerste device: ${device.host}`);
      discovery.destroy?.();
      resolve(device);
    });
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      discovery.destroy?.();
      reject(new Error('Geen Sonos gevonden binnen timeout'));
    }, timeoutMs);
  });
}

async function main() {
  const device = await findFirstDevice();

  const zoneAttrs = await device.getZoneAttrs();
  console.log(`Room: ${zoneAttrs.CurrentZoneName}`);

  const originalVolume = await device.getVolume();
  console.log(`Originele volume: ${originalVolume}`);

  console.log(`Zet volume naar ${TEST_VOLUME}...`);
  await device.setVolume(TEST_VOLUME);
  const readBack = await device.getVolume();
  console.log(`Volume gelezen: ${readBack}`);

  if (readBack !== TEST_VOLUME) {
    throw new Error(`Volume mismatch: zet ${TEST_VOLUME}, las ${readBack}`);
  }

  console.log(`Herstel volume naar ${originalVolume}...`);
  await device.setVolume(originalVolume);

  console.log('\n✓ Sanity OK — UPnP control werkt');
  process.exit(0);
}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
