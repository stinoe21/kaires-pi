// Kaires Pi runtime entry — iteratie 2b (library + heartbeat).
//
// Twee modi via KAIRES_USE_TEST_PLAYLIST:
//   1 = test mode  → 3 hardcoded test-MP3s, geen Supabase, voor on-site UPnP-validatie
//   0 = library    → DNA + realtime context + CAS-ranked tracks uit Supabase + heartbeat
//
// Pulse-loop: per track één query (forward + dedup), play, wait-for-end, herhaal.
// Geen vooruit-fetch queue zoals webapp; track-handoff is sequentieel.

import { config, summary, requireLibraryConfig } from './config.mjs';
import * as sonos from './output-sonos.mjs';

let running = true;
let currentAdapter = null;
let stopHeartbeat = () => {};

function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [runtime] ${msg}`);
}

function selectAdapter() {
  switch (config.output) {
    case 'sonos':
      return sonos;
    case 'alsa':
    case 'dlna':
      throw new Error(`Output adapter "${config.output}" nog niet geïmplementeerd`);
    default:
      throw new Error(`Onbekende KAIRES_OUTPUT: ${config.output}`);
  }
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
  'https://archive.org/download/testmp3testfile/mpthreetest.mp3',
  'https://www.kozco.com/tech/piano2-Audacity1.2.5.mp3',
  'https://www2.cs.uic.edu/~i101/SoundFiles/StarWars3.wav',
];

async function runTestMode() {
  log(`Test-mode: ${TEST_PLAYLIST.length} hardcoded tracks`);
  for (let i = 0; i < TEST_PLAYLIST.length && running; i++) {
    const url = TEST_PLAYLIST[i];
    log(`Test pulse #${i + 1}: ${url}`);
    try {
      await currentAdapter.play(url);
      const finalState = await currentAdapter.waitUntilEnded({ maxMs: 5 * 60_000 });
      log(`Track ${i + 1} klaar (${finalState})`);
    } catch (err) {
      log(`Pulse-fout: ${err.message}`);
    }
  }
  log('Test-playlist voltooid.');
  await shutdown('test-done');
}

// ── Library mode ─────────────────────────────────────────────────────────

async function runLibraryMode() {
  requireLibraryConfig();

  // Dynamic imports — alleen laden in library-mode zodat test-mode geen
  // Supabase-creds vereist.
  const library = await import('./library.mjs');
  const heartbeat = await import('./heartbeat.mjs');

  log(`Library-mode voor store ${config.store.id}`);
  heartbeat.startHeartbeat();
  stopHeartbeat = heartbeat.stopHeartbeat;

  // DNA + context laden vóór pulse-loop. DNA wordt niet per pulse opnieuw
  // gefetched — verandert zelden, refresh elke ~10 minuten via eenvoudige
  // tijd-gate (stub voor MVP, echte refresh komt in 2c).
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
    // Refresh DNA als ouder dan 10 min
    if (Date.now() - dnaFetchedAt > DNA_REFRESH_MS) {
      try {
        const fresh = await library.getStoreDNA(config.store.id);
        if (fresh) dna = fresh;
        dnaFetchedAt = Date.now();
      } catch (err) {
        log(`DNA-refresh faalde: ${err.message}`);
      }
    }

    // Realtime context elke pulse — verandert continu (foot traffic, noise, weer)
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
      await currentAdapter.play(track.url);
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
  currentAdapter = selectAdapter();
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
