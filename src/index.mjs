// Kaires Pi runtime — iteratie 2a (bare pulse loop, geen Supabase).
//
// Bewijst end-to-end: pulse-loop → adapter.play → end-detect → volgende track.
// Hardcoded test-playlist; library-query + CAS komen in 2b.
//
// Stoppen: Ctrl+C. SIGTERM/SIGINT triggert stop() op de adapter.

import { config, summary } from './config.mjs';
import * as sonos from './output-sonos.mjs';

const TEST_PLAYLIST = [
  'https://archive.org/download/testmp3testfile/mpthreetest.mp3',
  'https://www.kozco.com/tech/piano2-Audacity1.2.5.mp3',
  'https://www2.cs.uic.edu/~i101/SoundFiles/StarWars3.wav',
];

let running = true;
let currentAdapter = null;

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

async function main() {
  log(`Bootstrap — config: ${JSON.stringify(summary())}`);

  currentAdapter = selectAdapter();
  await currentAdapter.connect();

  log(`Pulse-loop gestart, ${TEST_PLAYLIST.length} test-tracks in queue`);

  let trackIdx = 0;
  while (running) {
    const url = TEST_PLAYLIST[trackIdx % TEST_PLAYLIST.length];
    log(`Pulse #${trackIdx + 1} — track: ${url}`);

    try {
      await currentAdapter.play(url);
      const finalState = await currentAdapter.waitUntilEnded({ maxMs: 5 * 60_000 });
      log(`Track ${trackIdx + 1} klaar (${finalState})`);
    } catch (err) {
      log(`Pulse-fout: ${err.message} — wacht ${config.pulseIntervalMs / 1000}s en probeer opnieuw`);
      await new Promise(r => setTimeout(r, config.pulseIntervalMs));
    }

    trackIdx += 1;
    if (trackIdx >= TEST_PLAYLIST.length) {
      log(`Test-playlist voltooid (${trackIdx} tracks gespeeld). Stop.`);
      break;
    }
  }

  await shutdown('playlist-done');
}

main().catch(async (err) => {
  console.error('FATAL:', err);
  await shutdown('fatal-error');
});
