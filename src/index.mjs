// Kaires Pi runtime entry — iteratie 2c (lan-http rehost-mode bij).
//
// Output adapters (KAIRES_OUTPUT):
//   sonos     — UPnP push naar Sonos (productie-pad)
//   lan-http  — Pi serveert audio via HTTP, MacBook/browser/Sonos pulled
//
// Modi (KAIRES_USE_TEST_PLAYLIST):
//   1 = test mode  → 3 hardcoded test-MP3s, geen Supabase nodig
//   0 = library    → DNA + realtime context + CAS-ranked tracks uit Supabase
//
// In lan-http mode worden alle URLs door de audio-cache layer geleid: Pi
// downloadt remote URL → audio-cache/<id>.<ext> → adapter speelt /audio/<id>.<ext>.
// In sonos mode wordt de URL direct doorgegeven (Supabase signed URL); cache
// kan later alsnog ingehaakt worden voor Sonos productie.

import { config, summary, requireLibraryConfig } from './config.mjs';
import * as sonos from './output-sonos.mjs';
import * as lanHttp from './output-lan-http.mjs';
import { fetchToCache } from './audio-cache.mjs';

let running = true;
let currentAdapter = null;
let adapterName = null;
let stopHeartbeat = () => {};

function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [runtime] ${msg}`);
}

function selectAdapter() {
  switch (config.output) {
    case 'sonos':    return { name: 'sonos',    impl: sonos };
    case 'lan-http': return { name: 'lan-http', impl: lanHttp };
    case 'alsa':
    case 'dlna':
      throw new Error(`Output adapter "${config.output}" nog niet geïmplementeerd`);
    default:
      throw new Error(`Onbekende KAIRES_OUTPUT: ${config.output}`);
  }
}

// Resolve URL afhankelijk van adapter:
//  - lan-http: download naar cache, retourneer relatieve /audio/<id>.<ext>
//  - sonos: passthrough (Sonos pulled direct van Supabase voor MVP)
async function resolveUrlForAdapter(remoteUrl, trackId) {
  if (adapterName === 'lan-http') {
    return fetchToCache(remoteUrl, trackId);
  }
  return remoteUrl;
}

async function shutdown(reason) {
  if (!running) return;
  running = false;
  log(`Shutdown (${reason})...`);
  try { stopHeartbeat(); } catch {}
  if (currentAdapter) {
    await currentAdapter.stop().catch(() => {});
  }
  log('Bye.');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  console.error('UnhandledRejection:', err);
  shutdown('unhandledRejection');
});

// ── Test mode ────────────────────────────────────────────────────────────

const TEST_PLAYLIST = [
  { id: 'test-1', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3', title: 'SoundHelix Song 1', artist: 'SoundHelix' },
  { id: 'test-2', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3', title: 'SoundHelix Song 2', artist: 'SoundHelix' },
  { id: 'test-3', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3', title: 'SoundHelix Song 3', artist: 'SoundHelix' },
];

async function runTestMode() {
  log(`Test-mode: ${TEST_PLAYLIST.length} hardcoded tracks`);
  for (let i = 0; i < TEST_PLAYLIST.length && running; i++) {
    const t = TEST_PLAYLIST[i];
    log(`Test pulse #${i + 1}: ${t.artist} — ${t.title}`);
    try {
      const playUrl = await resolveUrlForAdapter(t.url, t.id);
      await currentAdapter.play(playUrl, { id: t.id, title: t.title, artist: t.artist });
      const finalState = await currentAdapter.waitUntilEnded({ maxMs: 10 * 60_000 });
      log(`Track ${i + 1} klaar (${finalState})`);
    } catch (err) {
      log(`Pulse-fout: ${err.message}`);
    }
  }
  log('Test-playlist voltooid — server blijft draaien voor diagnostiek (Ctrl+C om te stoppen).');
  // Bewust geen shutdown: bij dode URLs of debugging wil je de browser-state behouden
  await new Promise(() => {}); // wacht oneindig op SIGINT/SIGTERM
}

// ── Library mode ─────────────────────────────────────────────────────────

async function runLibraryMode() {
  requireLibraryConfig();

  const library = await import('./library.mjs');
  const heartbeat = await import('./heartbeat.mjs');

  log(`Library-mode voor store ${config.store.id}`);
  heartbeat.startHeartbeat();
  stopHeartbeat = heartbeat.stopHeartbeat;

  let dna = await library.getStoreDNA(config.store.id);
  if (!dna) {
    log(`WAARSCHUWING: geen DNA voor store ${config.store.id} — gebruik defaults`);
    dna = {};
  } else {
    log(`DNA geladen: ${dna.brand_name ?? '(unnamed)'}`);
  }
  let dnaFetchedAt = Date.now();
  const DNA_REFRESH_MS = 10 * 60 * 1000;

  while (running) {
    if (Date.now() - dnaFetchedAt > DNA_REFRESH_MS) {
      try {
        const fresh = await library.getStoreDNA(config.store.id);
        if (fresh) dna = fresh;
        dnaFetchedAt = Date.now();
      } catch (err) {
        log(`DNA-refresh faalde: ${err.message}`);
      }
    }

    let context = null;
    try {
      context = await library.getRealtimeContext(config.store.id);
    } catch (err) {
      log(`Context fetch faalde, gebruik default: ${err.message}`);
    }

    let track = null;
    try {
      track = await library.fetchNextTrack({
        storeId: config.store.id,
        dna,
        context: context ?? {},
      });
    } catch (err) {
      log(`fetchNextTrack faalde: ${err.message}`);
    }

    if (!track) {
      log(`Geen track — wacht ${config.pulseIntervalMs / 1000}s en probeer opnieuw`);
      await new Promise(r => setTimeout(r, config.pulseIntervalMs));
      continue;
    }

    log(`Pulse → ${track.artist} - ${track.title} (CAS=${track.cas.toFixed(2)})`);
    heartbeat.setLastTrackId(track.id);
    heartbeat.incrementPulse();

    try {
      const playUrl = await resolveUrlForAdapter(track.url, track.id);
      await currentAdapter.play(playUrl, {
        id: track.id,
        title: track.title,
        artist: track.artist,
        cas: track.cas,
      });
      const finalState = await currentAdapter.waitUntilEnded({ maxMs: 10 * 60_000 });
      log(`Track klaar (${finalState})`);
    } catch (err) {
      log(`Play-fout: ${err.message} — wacht 10s, probeer volgende`);
      await new Promise(r => setTimeout(r, 10_000));
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  log(`Bootstrap — config: ${JSON.stringify(summary())}`);
  const sel = selectAdapter();
  currentAdapter = sel.impl;
  adapterName = sel.name;
  await currentAdapter.connect();

  if (config.useTestPlaylist) {
    await runTestMode();
  } else {
    await runLibraryMode();
  }
}

main().catch(async (err) => {
  console.error('FATAL:', err);
  await shutdown('fatal-error');
});
