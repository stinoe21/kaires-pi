// Audio cache — Pi downloadt remote URLs naar lokale disk en exposeert
// een stabiele LAN-URL (/audio/<id>.<ext>) die de MacBook (of Sonos) kan
// streamen. Lost twee problemen op:
//  1) Sonos/Mac kan geen Supabase signed URL met query-string betrouwbaar
//     spelen over publiek internet (auth-quirks, latency, Supabase down).
//  2) Cache geeft buffer bij netwerk-hiccup tussen Pi en Supabase.

import { mkdir, readdir, stat, unlink, writeFile, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve as resolvePath, extname } from 'node:path';
import { config } from './config.mjs';

const CACHE_DIR = resolvePath(process.cwd(), config.cache.dir);
const MAX_FILES = config.cache.maxFiles;

let initialized = false;

function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [cache] ${msg}`);
}

async function ensureInit() {
  if (initialized) return;
  await mkdir(CACHE_DIR, { recursive: true });
  initialized = true;
  log(`Cache-dir: ${CACHE_DIR} (max ${MAX_FILES} bestanden)`);
}

function deriveExtension(remoteUrl) {
  try {
    const u = new URL(remoteUrl);
    const ext = extname(u.pathname).toLowerCase();
    if (['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.aac'].includes(ext)) return ext;
  } catch {}
  return '.mp3';
}

async function fileExists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function lruCleanup() {
  const entries = await readdir(CACHE_DIR);
  if (entries.length <= MAX_FILES) return;

  const stats = await Promise.all(
    entries.map(async name => {
      const full = resolvePath(CACHE_DIR, name);
      const s = await stat(full).catch(() => null);
      return s ? { name, full, mtime: s.mtimeMs } : null;
    })
  );
  const valid = stats.filter(Boolean).sort((a, b) => a.mtime - b.mtime);
  const toRemove = valid.slice(0, valid.length - MAX_FILES);
  for (const item of toRemove) {
    await unlink(item.full).catch(err => log(`Cleanup faalde voor ${item.name}: ${err.message}`));
  }
  if (toRemove.length) log(`LRU: ${toRemove.length} oude bestand(en) verwijderd`);
}

/**
 * Download remote URL naar cache. Retourneert relatieve URL (/audio/<id>.<ext>)
 * die de browser kan ophalen via de HTTP-server. Slaat over als bestand bestaat.
 */
export async function fetchToCache(remoteUrl, trackId) {
  await ensureInit();

  const ext = deriveExtension(remoteUrl);
  const filename = `${trackId}${ext}`;
  const fullPath = resolvePath(CACHE_DIR, filename);
  const relativeUrl = `/audio/${filename}`;

  if (await fileExists(fullPath)) {
    log(`HIT ${filename}`);
    // Bump mtime zodat LRU dit als "recently used" telt
    const now = new Date();
    const { utimes } = await import('node:fs/promises');
    await utimes(fullPath, now, now).catch(() => {});
    return relativeUrl;
  }

  log(`MISS ${filename} — download van ${remoteUrl.slice(0, 60)}...`);
  const startedAt = Date.now();

  const res = await fetch(remoteUrl);
  if (!res.ok) {
    throw new Error(`Download faalde voor ${remoteUrl}: HTTP ${res.status}`);
  }
  if (!res.body) {
    throw new Error(`Download faalde voor ${remoteUrl}: lege body`);
  }

  await pipeline(Readable.fromWeb(res.body), createWriteStream(fullPath));
  const ms = Date.now() - startedAt;
  log(`Klaar in ${ms}ms → ${filename}`);

  // Cleanup async, blokkeert volgende play niet
  void lruCleanup().catch(err => log(`LRU error: ${err.message}`));

  return relativeUrl;
}

export function getCachePath(filename) {
  return resolvePath(CACHE_DIR, filename);
}
