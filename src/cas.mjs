// CAS engine — port van services/curation-engine.ts.
// Pure functies, geen Supabase, geen state. Identieke semantiek aan de
// webapp zodat track-selectie tussen iPad en Pi byte-equivalent is.
//
// Bij webapp-changes: sync deze file, refactor pas wanneer drift pijn doet.
// Roadmap: shared @kaires/curation-core npm package wanneer 2+ consumers bestaan.

const TEMPO_CONVERSION_MULTIPLIER = {
  browse: 0.88,
  conversion: 1.0,
  speed_throughput: 1.12,
};

const DEFAULT_WEIGHTS = {
  drukte: 0.35,
  decibel: 0.25,
  tijdstip: 0.20,
  weer: 0.12,
  temperatuur: 0.08,
};

const WEATHER_MAP = {
  sunny: 0.8,
  heat: 0.7,
  cloudy: 0.5,
  overcast: 0.5,
  cold: 0.3,
  rainy: 0.3,
  rain: 0.3,
  snowy: 0.2,
  storm: 0.1,
};

const TEMP_FROM_WEATHER = {
  sunny: 22,
  heat: 30,
  cold: 5,
  rainy: 12,
  rain: 12,
  overcast: 15,
  cloudy: 15,
  snowy: -2,
  storm: 10,
};

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

function softClamp(v, min, max, margin = 0.15) {
  const pad = (max - min) * margin;
  return clamp(v, min - pad, max + pad);
}

function blendWithDNA(raw, dnaMin, dnaMax, rigidity) {
  const center = (dnaMin + dnaMax) / 2;
  const blended = raw * (1 - rigidity) + center * rigidity;
  return softClamp(blended, dnaMin, dnaMax);
}

function normalizeFootTraffic(v) {
  return clamp(v / 100, 0, 1);
}

function normalizeDecibel(db) {
  return clamp((db - 40) / 50, 0, 1);
}

function normalizeTimeOfDay(hour) {
  if (hour < 6) return 0.1;
  if (hour < 9) return 0.2 + ((hour - 6) / 3) * 0.3;
  if (hour < 12) return 0.5 + ((hour - 9) / 3) * 0.5;
  if (hour <= 18) return 1.0;
  if (hour < 21) return 1.0 - ((hour - 18) / 3) * 0.6;
  return 0.2;
}

function normalizeWeather(condition) {
  return WEATHER_MAP[(condition ?? '').toLowerCase()] ?? 0.5;
}

function normalizeTemperature(c) {
  return clamp((c + 10) / 45, 0, 1);
}

function estimateTemperatureFromWeather(condition) {
  return TEMP_FROM_WEATHER[(condition ?? '').toLowerCase()] ?? 18;
}

function calculateCAS(inputs, weights) {
  const w = { ...DEFAULT_WEIGHTS, ...(weights ?? {}) };
  const sum = w.drukte + w.decibel + w.tijdstip + w.weer + w.temperatuur;
  const scale = sum > 0 ? 1 / sum : 1;
  const cas =
    inputs.drukte * w.drukte * scale +
    inputs.decibel * w.decibel * scale +
    inputs.tijdstip * w.tijdstip * scale +
    inputs.weer * w.weer * scale +
    inputs.temperatuur * w.temperatuur * scale;
  return clamp(cas, 0, 1);
}

function mapCASToTargetParams(cas, dna, conversionFocus = 'conversion') {
  const raw = {
    target_tempo: 60 + cas * 50,
    target_energy: 0.20 + cas * 0.70,
    target_valence: 0.30 + cas * 0.55,
    target_danceability: 0.30 + cas * 0.60,
  };

  let result;
  if (dna) {
    const rigidity = clamp(dna.brand_rigidity ?? 0.3, 0, 1);
    result = {
      target_tempo: blendWithDNA(raw.target_tempo, dna.bpm_min, dna.bpm_max, rigidity),
      target_energy: clamp(blendWithDNA(raw.target_energy, dna.energy_min ?? 0, 1.0, rigidity), 0, 1),
      target_valence: clamp(blendWithDNA(raw.target_valence, dna.valence_min ?? 0, 1.0, rigidity), 0, 1),
      target_danceability: clamp(
        blendWithDNA(
          raw.target_danceability,
          dna.danceability_min ?? 0,
          dna.danceability_max ?? 1.0,
          rigidity
        ),
        0,
        1
      ),
      seed_genres: dna.seed_genres,
    };
  } else {
    result = raw;
  }

  const multiplier = TEMPO_CONVERSION_MULTIPLIER[conversionFocus] ?? 1.0;
  result.target_tempo = clamp(result.target_tempo * multiplier, 60, 130);
  return result;
}

export function computeCurationParams({
  footTraffic,
  noiseFloorDb,
  weather,
  temperatureC,
  weights,
  dna,
  hour,
  conversionFocus,
}) {
  const h = typeof hour === 'number'
    ? Math.max(0, Math.min(23, Math.floor(hour)))
    : new Date().getHours();
  const t = temperatureC ?? estimateTemperatureFromWeather(weather);

  const normalized = {
    drukte: normalizeFootTraffic(Number.isFinite(footTraffic) ? footTraffic : 50),
    decibel: normalizeDecibel(Number.isFinite(noiseFloorDb) ? noiseFloorDb : 45),
    tijdstip: normalizeTimeOfDay(h),
    weer: normalizeWeather(weather),
    temperatuur: normalizeTemperature(Number.isFinite(t) ? t : 18),
  };

  const effectiveWeights = { ...DEFAULT_WEIGHTS, ...(weights ?? dna?.weights_override ?? {}) };
  const cas = calculateCAS(normalized, effectiveWeights);
  const params = mapCASToTargetParams(cas, dna, conversionFocus);

  return { cas, params, normalized, effectiveWeights };
}
