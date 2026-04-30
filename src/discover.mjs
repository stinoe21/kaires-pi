// Fase-1 stap 1: SSDP-discovery
// Scant het LAN naar Sonos-devices via multicast. Logt elk gevonden device
// met hostname, IP, modelnaam, room-naam, en zone-coordinator status.
//
// Gebruik:
//   node src/discover.mjs                 # 10s scan
//   node src/discover.mjs 30              # 30s scan
//   KAIRES_SONOS_HINT_IP=192.168.1.50 \   # bypass multicast als netwerk dat blokkeert
//     node src/discover.mjs

import { DeviceDiscovery, Sonos } from 'sonos';

const TIMEOUT_SEC = Number(process.argv[2] ?? 10);
const HINT_IP = process.env.KAIRES_SONOS_HINT_IP;

const seen = new Map();

function logDevice(device, source) {
  const host = device.host;
  if (seen.has(host)) return;
  seen.set(host, device);
  console.log(`\n[${source}] Sonos device gevonden: ${host}`);
}

async function describeAll() {
  if (seen.size === 0) {
    console.log('\nGeen Sonos-devices gevonden.');
    return;
  }
  console.log(`\n--- Details (${seen.size} device${seen.size > 1 ? 's' : ''}) ---`);
  for (const [host, device] of seen) {
    try {
      const desc = await device.deviceDescription();
      const zoneAttrs = await device.getZoneAttrs().catch(() => ({}));
      const zoneInfo = await device.getZoneInfo().catch(() => ({}));
      console.log(`\n  Host:        ${host}`);
      console.log(`  Room:        ${zoneAttrs.CurrentZoneName ?? desc.roomName ?? '?'}`);
      console.log(`  Model:       ${desc.modelName ?? '?'} (${desc.modelNumber ?? '?'})`);
      console.log(`  Software:    ${desc.softwareVersion ?? '?'}`);
      console.log(`  Serial:      ${zoneInfo.SerialNumber ?? desc.serialNum ?? '?'}`);
      console.log(`  UUID:        ${desc.UDN ?? '?'}`);
    } catch (err) {
      console.log(`  ${host}: kon details niet ophalen — ${err.message}`);
    }
  }

  // Probeer zone-groep informatie via eerste device
  const first = seen.values().next().value;
  try {
    const groupState = await first.getAllGroups();
    console.log(`\n--- Zone groups ---`);
    for (const group of groupState) {
      const coordinator = group.host ?? group.CoordinatorIPAddress ?? '?';
      const members = (group.ZoneGroupMember ?? []).map(m => m.ZoneName ?? '?').join(', ');
      console.log(`  Coordinator: ${coordinator} | Members: ${members || group.Name || '?'}`);
    }
  } catch (err) {
    console.log(`\nKon zone-groups niet ophalen: ${err.message}`);
  }
}

async function main() {
  console.log(`SSDP scan (${TIMEOUT_SEC}s)...`);

  if (HINT_IP) {
    console.log(`Hint IP geconfigureerd: ${HINT_IP} — probeer direct te verbinden`);
    const direct = new Sonos(HINT_IP);
    logDevice(direct, 'hint');
  }

  const discovery = DeviceDiscovery({ timeout: TIMEOUT_SEC * 1000 });
  discovery.on('DeviceAvailable', (device) => logDevice(device, 'ssdp'));

  await new Promise(resolve => setTimeout(resolve, TIMEOUT_SEC * 1000));
  discovery.destroy?.();

  await describeAll();
  process.exit(seen.size > 0 ? 0 : 1);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(2);
});
