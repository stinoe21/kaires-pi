// Config loader — leest .env, valideert, exporteert getypte config.
// Faalt fast met duidelijke fout als verplichte vars ontbreken.

import 'dotenv/config';

const VALID_OUTPUTS = ['sonos', 'alsa', 'dlna'];

function required(name) {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missende verplichte env var: ${name}`);
  }
  return v.trim();
}

function optional(name, fallback = undefined) {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : fallback;
}

const output = optional('KAIRES_OUTPUT', 'sonos');
if (!VALID_OUTPUTS.includes(output)) {
  throw new Error(`KAIRES_OUTPUT="${output}" ongeldig. Toegestaan: ${VALID_OUTPUTS.join(', ')}`);
}

// Test-mode: skip Supabase init zodat de Phase-1 scripts (discover/sanity/play-test)
// en het bare-runtime test-pad (USE_TEST_PLAYLIST=1) kunnen draaien zonder creds.
const useTestPlaylist = optional('KAIRES_USE_TEST_PLAYLIST') === '1';

export const config = {
  output,
  sonos: {
    hintIp: optional('KAIRES_SONOS_HINT_IP'),
  },
  store: {
    id: optional('KAIRES_STORE_ID'),
    name: optional('KAIRES_STORE_NAME'),
  },
  supabase: {
    url: optional('SUPABASE_URL'),
    anonKey: optional('SUPABASE_ANON_KEY'),
  },
  testAudioUrl: optional(
    'KAIRES_TEST_AUDIO_URL',
    'https://archive.org/download/testmp3testfile/mpthreetest.mp3'
  ),
  useTestPlaylist,
  pulseIntervalMs: Number(optional('KAIRES_PULSE_INTERVAL_MS', '60000')),
  trackEndPollMs: Number(optional('KAIRES_TRACK_END_POLL_MS', '5000')),
  heartbeatIntervalMs: Number(optional('KAIRES_HEARTBEAT_INTERVAL_MS', '30000')),
  appVersion: optional('KAIRES_APP_VERSION', 'pi-dev'),
};

export function summary() {
  return {
    output: config.output,
    sonos_hint: config.sonos.hintIp ?? '(SSDP)',
    store: config.store.name ?? config.store.id ?? '(none)',
    mode: config.useTestPlaylist ? 'test-playlist' : 'library',
    pulse: `${config.pulseIntervalMs / 1000}s`,
    heartbeat: `${config.heartbeatIntervalMs / 1000}s`,
  };
}

export function requireLibraryConfig() {
  const missing = [];
  if (!config.supabase.url) missing.push('SUPABASE_URL');
  if (!config.supabase.anonKey) missing.push('SUPABASE_ANON_KEY');
  if (!config.store.id) missing.push('KAIRES_STORE_ID');
  if (missing.length > 0) {
    throw new Error(
      `Library-mode vereist deze env vars: ${missing.join(', ')}.\n` +
      'Of zet KAIRES_USE_TEST_PLAYLIST=1 voor de hardcoded test-tracks.'
    );
  }
}
