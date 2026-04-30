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

export const config = {
  output,
  sonos: {
    hintIp: optional('KAIRES_SONOS_HINT_IP'),
  },
  store: {
    id: optional('KAIRES_STORE_ID'),
    name: optional('KAIRES_STORE_NAME'),
  },
  testAudioUrl: optional(
    'KAIRES_TEST_AUDIO_URL',
    'https://archive.org/download/testmp3testfile/mpthreetest.mp3'
  ),
  pulseIntervalMs: Number(optional('KAIRES_PULSE_INTERVAL_MS', '60000')),
  trackEndPollMs: Number(optional('KAIRES_TRACK_END_POLL_MS', '5000')),
};

export function summary() {
  return {
    output: config.output,
    sonos_hint: config.sonos.hintIp ?? '(SSDP)',
    store: config.store.name ?? '(none)',
    pulse: `${config.pulseIntervalMs / 1000}s`,
  };
}
