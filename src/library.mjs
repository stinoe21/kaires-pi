// Library — DNA-aware track-query, dedup, signed-URL, en playlist-log.
// Geport van services/library.ts + services/supabase-dna.ts (webapp).
//
// MVP-vereenvoudigingen vergeleken met webapp:
// - Geen retry-queue voor playlist_log inserts (fire-and-forget)
// - Geen dimensionele FK-resolutie (source_id/track_surrogate_key/curation_params_id = null)
// - Geen operator feedback (likes/dislikes/removed) — komt in iteratie 2c
// - Geen blacklisted_artists filter — komt in iteratie 2c
// - Sessie-dedup is in-memory voor de duur van het Pi-proces

import { supabase } from './lib/supabase.mjs';
import { config } from './config.mjs';
import { computeCurationParams } from './cas.mjs';

const DEDUP_HARD_BLOCK_HOURS = 1;
const DEDUP_FREQUENCY_CAP_HOURS = 3;
const DEDUP_CACHE_TTL_MS = 5 * 60 * 1000;
const SIGNED_URL_TTL_SEC = 86_400;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sessionTrackIds = new Set();
const dedupCache = new Map(); // key=`${storeId}:${windowHours}` → { ids, fetchedAt }

function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [library] ${msg}`);
}

// ── DNA & Context fetch ──────────────────────────────────────────────────

export async function getStoreDNA(storeId) {
  const { data, error } = await supabase
    .from('retailer_music_dna')
    .select('*')
    .eq('store_id', storeId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getRealtimeContext(storeId) {
  const { data, error } = await supabase
    .from('realtime_context')
    .select('*')
    .eq('store_id', storeId)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

// ── Dedup ────────────────────────────────────────────────────────────────

async function getRecentTrackIdsFromLog(storeId, windowHours) {
  const cacheKey = `${storeId}:${windowHours}`;
  const cached = dedupCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < DEDUP_CACHE_TTL_MS) {
    return cached.ids;
  }

  const cutoff = new Date(Date.now() - windowHours * 3600_000).toISOString();
  const { data, error } = await supabase
    .from('playlist_log')
    .select('track_id, track_surrogate_key')
    .eq('store_id', storeId)
    .gt('played_at', cutoff)
    .limit(10_000);

  if (error) throw error;
  const ids = new Set();
  for (const row of data ?? []) {
    if (row.track_id) ids.add(row.track_id);
    if (row.track_surrogate_key) ids.add(row.track_surrogate_key);
  }
  dedupCache.set(cacheKey, { ids, fetchedAt: Date.now() });
  return ids;
}

function invalidateDedupCache(storeId) {
  for (const key of dedupCache.keys()) {
    if (key.startsWith(`${storeId}:`)) dedupCache.delete(key);
  }
}

// ── Track scoring (CAS-distance) ─────────────────────────────────────────

function deriveSecondaryTargets(params, dna) {
  const cas = Math.max(0, Math.min(1, (params.target_energy - 0.20) / 0.70));
  return {
    target_loudness_lufs: -18 + cas * 5,
    target_acousticness: 1.0 - cas,
    target_instrumentalness: (dna?.instrumentalness_max ?? 1.0) * 0.5,
    min_tempo_stability: 0.5,
    max_speechiness: 0.33,
    max_liveness: 0.7,
    max_intro_silence_ms: 4000,
  };
}

function casDistance(track, params, extra) {
  const dE = track.energy - params.target_energy;
  const dV = track.valence - params.target_valence;
  const dT = (track.tempo - params.target_tempo) / 100;
  const dD = track.danceability - params.target_danceability;
  let sq = dE * dE + dV * dV + dT * dT + dD * dD;

  const loudness = track.loudness ?? extra.target_loudness_lufs;
  const dL = (loudness - extra.target_loudness_lufs) / 20;
  const dA = (track.acousticness ?? extra.target_acousticness) - extra.target_acousticness;
  const dI = (track.instrumentalness ?? extra.target_instrumentalness) - extra.target_instrumentalness;
  sq += 0.5 * (dL * dL + dA * dA + dI * dI);

  const stab = track.tempo_stability;
  if (stab != null && stab < extra.min_tempo_stability) sq += (extra.min_tempo_stability - stab) * 2;
  const speech = track.speechiness ?? 0;
  if (speech > extra.max_speechiness) sq += (speech - extra.max_speechiness) * 2;
  const live = track.liveness ?? 0;
  if (live > extra.max_liveness) sq += (live - extra.max_liveness) * 2;
  const intro = track.intro_silence_ms;
  if (intro != null && intro > extra.max_intro_silence_ms) {
    sq += ((intro - extra.max_intro_silence_ms) / 5000) * 0.5;
  }
  return Math.sqrt(sq);
}

// ── Track-query met 3-laagse fallback ────────────────────────────────────

async function queryLibraryTracks(params, excludeIds, hardBlockFallbackIds, dna) {
  const buildBaseQuery = () => {
    let q = supabase.from('tracks').select('*').not('danceability', 'is', null).limit(50);
    if (!dna.explicit_allowed) q = q.eq('explicit', false);
    if (dna.instrumentalness_max != null && dna.instrumentalness_max < 1) {
      q = q.or(`instrumentalness.lte.${dna.instrumentalness_max},instrumentalness.is.null`);
    }
    return q;
  };

  const applyExclude = (q, ids) => {
    const sanitized = ids.filter(id => UUID_RE.test(id));
    if (sanitized.length === 0) return q;
    const capped = sanitized.length > 150 ? sanitized.slice(-150) : sanitized;
    return q.not('id', 'in', `(${capped.join(',')})`);
  };

  const secondary = deriveSecondaryTargets(params, dna);
  const rank = (rows) => rows
    .map(t => ({ track: t, dist: casDistance(t, params, secondary) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, Math.min(rows.length, 50))
    .map(r => r.track);

  // Tier 1: full exclude
  const { data, error } = await applyExclude(buildBaseQuery(), excludeIds);
  if (error) {
    log(`Supabase query error: ${error.message}`);
    return [];
  }
  if (data?.length) return rank(data);

  // Tier 2: hard-block only
  if (hardBlockFallbackIds.length > 0 && hardBlockFallbackIds.length < excludeIds.length) {
    log(`Hardblock-fallback: pool van ${excludeIds.length} → ${hardBlockFallbackIds.length}`);
    const { data: tier2 } = await applyExclude(buildBaseQuery(), hardBlockFallbackIds);
    if (tier2?.length) return rank(tier2);
  }

  // Tier 3: no excludes
  if (excludeIds.length > 0 || hardBlockFallbackIds.length > 0) {
    log('Fallback zonder excludes — pool volledig uitgeput');
    const { data: tier3 } = await buildBaseQuery();
    if (tier3?.length) return rank(tier3);
  }

  return [];
}

// ── Signed URL ───────────────────────────────────────────────────────────

async function getSignedUrl(filePath) {
  const { data, error } = await supabase.storage
    .from('music-library')
    .createSignedUrl(filePath, SIGNED_URL_TTL_SEC);
  if (error || !data) return null;
  return data.signedUrl;
}

// ── Playlist log ─────────────────────────────────────────────────────────

async function logPlaylistDecision(entry) {
  const payload = {
    store_id: entry.store_id,
    cas_score: entry.cas_score,
    spotify_params: entry.spotify_params,
    track_id: entry.track_id,
    track_name: entry.track_name,
    artist_name: entry.artist_name,
    source_id: null,                 // dimensionele lookup overslagen voor MVP
    track_surrogate_key: null,
    curation_params_id: null,
    context_snapshot: entry.context_snapshot ?? null,
    target_tempo: entry.spotify_params.target_tempo,
    target_energy: entry.spotify_params.target_energy,
    target_valence: entry.spotify_params.target_valence,
    target_danceability: entry.spotify_params.target_danceability,
  };

  const { error } = await supabase.from('playlist_log').insert(payload);
  if (error) {
    log(`Playlist-log insert faalde (non-blocking): ${error.message}`);
    return;
  }
  invalidateDedupCache(entry.store_id);
}

// ── Public API: fetch next track voor de runtime ─────────────────────────

export async function fetchNextTrack({ storeId, dna, context }) {
  // Refresh dedup-vensters (cached 5min)
  let hardBlock = new Set();
  let freqCap = new Set();
  try {
    [hardBlock, freqCap] = await Promise.all([
      getRecentTrackIdsFromLog(storeId, DEDUP_HARD_BLOCK_HOURS),
      getRecentTrackIdsFromLog(storeId, DEDUP_FREQUENCY_CAP_HOURS),
    ]);
  } catch (err) {
    log(`Dedup-query faalde, val terug op session-only: ${err.message}`);
  }

  // CAS-berekening uit huidige context
  const ctx = context ?? {};
  const { cas, params: targetParams } = computeCurationParams({
    footTraffic: ctx.foot_traffic ?? 50,
    noiseFloorDb: ctx.noise_db ?? 45,
    weather: ctx.weather ?? 'cloudy',
    temperatureC: ctx.temperature,
    weights: dna?.weights_override,
    dna,
  });

  const excludeIds = [...sessionTrackIds, ...freqCap].filter(id => UUID_RE.test(id));
  const hardBlockFallbackIds = [...hardBlock].filter(id => UUID_RE.test(id));

  const candidates = await queryLibraryTracks(
    targetParams,
    excludeIds,
    hardBlockFallbackIds,
    {
      explicit_allowed: dna?.explicit_allowed ?? false,
      instrumentalness_max: dna?.instrumentalness_max ?? null,
      language_preference: dna?.language_preference ?? null,
    }
  );

  if (!candidates.length) {
    log('Geen kandidaten gevonden — catalogus leeg of volledig gededupt');
    return null;
  }

  // MVP: simple top-pick, geen weighted-random (komt met likes/dislikes in 2c).
  // Probeer max 3 kandidaten als signed-URL faalt (gedelete blob).
  for (let i = 0; i < Math.min(3, candidates.length); i++) {
    const candidate = candidates[i];
    const url = await getSignedUrl(candidate.file_path);
    if (!url) {
      log(`Signed URL null voor ${candidate.file_path} — volgende kandidaat`);
      continue;
    }

    // Markeer in sessie & log
    sessionTrackIds.add(candidate.id);

    logPlaylistDecision({
      store_id: storeId,
      cas_score: cas,
      spotify_params: targetParams,
      track_id: candidate.id,
      track_name: candidate.title,
      artist_name: candidate.artist,
      context_snapshot: {
        foot_traffic: ctx.foot_traffic ?? null,
        noise_db: ctx.noise_db ?? null,
        weather: ctx.weather === 'unknown' ? null : (ctx.weather ?? null),
        temperature: ctx.temperature ?? null,
      },
    }).catch(err => log(`Playlist-log error (non-blocking): ${err.message}`));

    return {
      id: candidate.id,
      title: candidate.title,
      artist: candidate.artist,
      url,
      cas,
      params: targetParams,
    };
  }

  log('Alle 3 kandidaten faalden op signed-URL — geef op');
  return null;
}
