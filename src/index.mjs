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
let stopAuxiliaries = () => {};

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
  try { await stopAuxiliaries(); } catch {}
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

// Operator-pause flag — gezet door pi-control-listener wanneer de webapp
// pause_requested op true zet. Pulse loop respecteert 'm: skip de fetch + play
// totdat 'ie weer op false staat. Begint false (we draaien direct na startup).
let pauseRequested = false;

// Routing-flag — true wanneer stores.playback_source != 'pi'. Operator heeft
// in het dashboard terug naar Webapp-mode getoggled; webapp neemt dan zelf
// playback over (in-browser <audio>). Pi moet stoppen anders speelt audio
// dubbel (browser + Sonos). Symmetrisch resume bij flip terug naar 'pi'.
let routedAway = false;

async function runLibraryMode() {
  requireLibraryConfig();

  const { signIn, supabase } = await import('./lib/supabase.mjs');
  const library = await import('./library.mjs');
  const heartbeat = await import('./heartbeat.mjs');
  const piDevice = await import('./pi-device.mjs');
  const piState = await import('./pi-state.mjs');
  const controlListener = await import('./pi-control-listener.mjs');
  const storeListener = await import('./store-listener.mjs');

  // Sign in BEFORE the heartbeat starts — heartbeat insert depends on the
  // session being live (RLS rejects anonymous writes).
  const piUserId = await signIn();
  log(`Pi-auth signed in as ${config.pi.email} (uid ${piUserId.slice(0, 8)}…)`);

  // Register this Pi in pi_devices zodat het webapp-dashboard de Audio Output
  // panel kan tonen. last_seen_at wordt elke heartbeat-tick ververst.
  await piDevice.registerPiDevice();
  piDevice.startTouchInterval();

  // Reset playback state to 'idle' op startup zodat we niet met stale
  // current_track_* van een vorige run draaien.
  await piState.setIdle();

  // Clear stale operator-pause op startup. Een Pi-restart komt vaak van
  // power-cut / OS-update — als de klant gisteren pauseerde wil 'ie vandaag
  // niet uren-stilte. Bovendien toont PlayerCard in (paused + geen track)
  // state geen knoppen, dus zonder dit blijft de klant vastzitten.
  try {
    await supabase
      .from('pi_devices')
      .update({ pause_requested: false, skip_requested_at: null })
      .eq('id', piDevice.getPiDeviceId());
  } catch { /* non-fatal — listener werkt ook zonder deze cleanup */ }

  // Watch stores.playback_source — wanneer operator naar Webapp-mode toggled
  // moet de Pi stoppen om dubbel-audio te voorkomen.
  await storeListener.startStoreListener({
    onChange: async (next) => {
      const shouldBeRoutedAway = next !== 'pi';
      if (shouldBeRoutedAway === routedAway) return;
      routedAway = shouldBeRoutedAway;
      if (routedAway) {
        log('Store routing flipte naar webapp — Pi gaat idle');
        try { await currentAdapter.stop(); } catch {}
        try { await piState.setIdle(); } catch {}
      } else {
        log('Store routing flipte terug naar pi — pulse loop pakt het weer op');
      }
    },
  });

  // Listen voor skip/pause-commando's vanuit het webapp-dashboard.
  await controlListener.startPiControlListener({
    onSkip: async () => {
      // Stop de huidige track — waitUntilEnded() retourneert dan 'stopped' en
      // de loop fetch automatisch de volgende. setIdle() niet nodig: de loop
      // schrijft setNowPlaying() voor de volgende track of setIdle() bij geen
      // track.
      try { await currentAdapter.stop(); } catch {}
      try { await piState.clearSkipRequest(); } catch {}
    },
    onPause: async () => {
      pauseRequested = true;
      try { await currentAdapter.stop(); } catch {}
      try { await piState.setPaused(); } catch {}
    },
    onPlay: async () => {
      pauseRequested = false;
      // De pulse loop pikt 'm vanzelf weer op binnen 5s.
    },
  });

  log(`Library-mode voor store ${config.store.id}`);
  heartbeat.startHeartbeat();
  stopHeartbeat = heartbeat.stopHeartbeat;

  // Sonos-only: speakers naar dashboard publiceren + luisteren naar het
  // is_active_output-vinkje zodat de operator/klant de output via de webapp
  // kiest. Andere adapters (lan-http) hebben geen externe target-keuze.
  if (adapterName === 'sonos') {
    const discovery = await import('./sonos-discovery.mjs');
    const listener = await import('./sonos-listener.mjs');
    await discovery.startSonosDiscovery();
    await listener.startSonosListener({
      onChange: async (next) => {
        try {
          await currentAdapter.setTargetSpeaker(next);
        } catch (err) {
          log(`Speaker-switch faalde: ${err.message}`);
        }
      },
    });
    stopAuxiliaries = async () => {
      try { piDevice.stopTouchInterval(); } catch {}
      try { discovery.stopSonosDiscovery(); } catch {}
      try { await listener.stopSonosListener(); } catch {}
      try { await controlListener.stopPiControlListener(); } catch {}
      try { await storeListener.stopStoreListener(); } catch {}
      try { await piState.setIdle(); } catch {}
    };
  } else {
    stopAuxiliaries = async () => {
      try { piDevice.stopTouchInterval(); } catch {}
      try { await controlListener.stopPiControlListener(); } catch {}
      try { await storeListener.stopStoreListener(); } catch {}
      try { await piState.setIdle(); } catch {}
    };
  }

  let dna = await library.getStoreDNA(config.store.id);
  if (!dna) {
    log(`WAARSCHUWING: geen DNA voor store ${config.store.id} — gebruik defaults`);
    dna = {};
  } else {
    log(`DNA geladen: ${dna.brand_name ?? '(unnamed)'}`);
  }
  let dnaFetchedAt = Date.now();
  const DNA_REFRESH_MS = 10 * 60 * 1000;

  let lastIdleWrittenForReason = null;
  const ensureIdleState = async (reason) => {
    if (lastIdleWrittenForReason === reason) return;
    lastIdleWrittenForReason = reason;
    if (reason === 'paused') {
      try { await piState.setPaused(); } catch {}
    } else {
      try { await piState.setIdle(); } catch {}
    }
  };

  while (running) {
    // Routed away: operator heeft store-source op 'webapp' gezet. Audio
    // moet niet via deze Pi lopen anders speelt 't dubbel. Heartbeat draait
    // gewoon door zodat dashboard ziet dat de Pi nog leeft.
    if (routedAway) {
      await ensureIdleState('routed_away');
      await new Promise(r => setTimeout(r, 2_000));
      continue;
    }

    // Pause-mode: webapp heeft pause_requested gezet. Loop blijft idle tot
    // play_requested-flip de pauseRequested vlag op false zet. Heartbeat
    // blijft doorlopen zodat het dashboard ziet dat we leven.
    if (pauseRequested) {
      await ensureIdleState('paused');
      await new Promise(r => setTimeout(r, 2_000));
      continue;
    }

    // Idle wanneer er geen output-target is (bv. Sonos-mode zonder gekozen
    // speaker in het dashboard). Pi blijft online + heartbeat blijft draaien;
    // we slaan alleen de pulse over zodat we geen tracks fetchen die nergens
    // heen kunnen.
    if (typeof currentAdapter.hasTarget === 'function' && !currentAdapter.hasTarget()) {
      await ensureIdleState('no_target');
      await new Promise(r => setTimeout(r, 5_000));
      continue;
    }
    // Niet-idle pad: reset zodat de eerstvolgende terugval wel weer geschreven wordt.
    lastIdleWrittenForReason = null;

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
      try { await piState.setIdle(); } catch {}
      lastIdleWrittenForReason = 'no_track';
      await new Promise(r => setTimeout(r, config.pulseIntervalMs));
      continue;
    }

    log(`Pulse → ${track.artist} - ${track.title} (CAS=${track.cas.toFixed(2)})`);
    heartbeat.setLastTrackId(track.id);
    heartbeat.incrementPulse();

    try {
      // Schrijf 'connecting' naar pi_devices vóór de UPnP-call zodat de
      // webapp meteen "loading <title>" kan tonen i.p.v. een leeg vinyl.
      await piState.setConnecting(track);
      const playUrl = await resolveUrlForAdapter(track.url, track.id);
      await currentAdapter.play(playUrl, {
        id: track.id,
        title: track.title,
        artist: track.artist,
        cas: track.cas,
      });
      // Audio is bevestigd onderweg — flip naar 'playing' zodat de webapp
      // de progress-bar lokaal kan animeren vanuit current_track_started_at.
      await piState.setNowPlaying(track);
      const finalState = await currentAdapter.waitUntilEnded({ maxMs: 10 * 60_000 });
      log(`Track klaar (${finalState})`);
    } catch (err) {
      log(`Play-fout: ${err.message} — wacht 10s, probeer volgende`);
      try { await piState.setIdle(); } catch {}
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
