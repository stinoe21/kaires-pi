// LAN-HTTP output adapter — Pi serveert audio via HTTP, browser/Sonos op
// het LAN doet het afspelen. Gebruikt voor:
//  - Test-omgeving (MacBook browser speelt af)
//  - Toekomstige Sonos-deploy (Sonos pulled van Pi i.p.v. Supabase direct)
//
// Adapter-interface match output-sonos.mjs zodat index.mjs één pulse-loop
// kan gebruiken voor beide modi.
//
// HTTP-routes:
//   GET  /                 → public/index.html (browser player)
//   GET  /audio/<file>     → serveert cache-bestand
//   GET  /api/now-playing  → JSON met huidige track
//   POST /api/track-ended  → browser ack: track is gestopt

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import { resolve as resolvePath, extname, basename } from 'node:path';
import { networkInterfaces } from 'node:os';
import { config } from './config.mjs';
import { getCachePath } from './audio-cache.mjs';

const PORT = config.http.port;
const BIND = config.http.bind;
const PUBLIC_DIR = resolvePath(process.cwd(), 'public');

let server = null;
let currentTrack = null;        // { url, title, artist, cas }
let trackEndedResolver = null;
let trackStartedAt = 0;

function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [lan-http] ${msg}`);
}

function getLanIPs() {
  const ips = [];
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] ?? []) {
      if (info.family === 'IPv4' && !info.internal) {
        ips.push(info.address);
      }
    }
  }
  return ips;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.m4a':  'audio/mp4',
  '.aac':  'audio/aac',
  '.ogg':  'audio/ogg',
  '.flac': 'audio/flac',
};

function contentType(path) {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

async function serveFile(res, path) {
  try {
    const s = await stat(path);
    if (!s.isFile()) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType(path),
      'Content-Length': s.size,
      'Cache-Control': 'no-cache',
      'Accept-Ranges': 'bytes',
    });
    createReadStream(path).pipe(res);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

async function serveAudio(res, filename) {
  // Sanitize: geen path traversal
  const safe = basename(filename);
  if (safe !== filename) {
    res.writeHead(400).end('Bad filename');
    return;
  }
  const full = getCachePath(safe);
  await serveFile(res, full);
}

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function handleTrackEnded() {
  if (trackEndedResolver) {
    const elapsed = Date.now() - trackStartedAt;
    log(`Track-ended ack ontvangen na ${(elapsed / 1000).toFixed(1)}s`);
    const r = trackEndedResolver;
    trackEndedResolver = null;
    r('stopped');
  }
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  // Lichte request log (skip /api/now-playing want die polled de browser)
  if (path !== '/api/now-playing') {
    log(`${req.method} ${path}`);
  }

  if (req.method === 'GET' && path === '/') {
    await serveFile(res, resolvePath(PUBLIC_DIR, 'index.html'));
    return;
  }

  if (req.method === 'GET' && path.startsWith('/audio/')) {
    await serveAudio(res, path.slice('/audio/'.length));
    return;
  }

  if (req.method === 'GET' && path === '/api/now-playing') {
    if (!currentTrack) {
      res.writeHead(204).end();
      return;
    }
    jsonResponse(res, 200, currentTrack);
    return;
  }

  if (req.method === 'POST' && path === '/api/track-ended') {
    handleTrackEnded();
    jsonResponse(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && path === '/api/healthz') {
    jsonResponse(res, 200, { ok: true, currentTrack: currentTrack?.id ?? null });
    return;
  }

  res.writeHead(404).end('Not found');
}

// ── Adapter-interface (match output-sonos.mjs) ───────────────────────────

export async function connect() {
  if (server) return;
  server = createServer((req, res) => {
    handler(req, res).catch(err => {
      log(`Handler-fout: ${err.message}`);
      try { res.writeHead(500).end('Internal error'); } catch {}
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, BIND, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const ips = getLanIPs();
  log(`HTTP-server live op poort ${PORT}`);
  log(`Open in browser:`);
  for (const ip of ips) log(`  → http://${ip}:${PORT}/`);
  log(`  → http://kai.local:${PORT}/  (mDNS)`);
}

export async function play(url, metadata = {}) {
  currentTrack = {
    id: metadata.id ?? null,
    url,
    title: metadata.title ?? '(unknown title)',
    artist: metadata.artist ?? '(unknown artist)',
    cas: metadata.cas ?? null,
    queuedAt: new Date().toISOString(),
  };
  trackStartedAt = Date.now();
  log(`Queued: ${currentTrack.artist} — ${currentTrack.title} (${url})`);
}

export async function waitUntilEnded({ maxMs = 600_000 } = {}) {
  return new Promise(resolve => {
    trackEndedResolver = resolve;
    setTimeout(() => {
      if (trackEndedResolver === resolve) {
        log(`Track-ended timeout na ${maxMs / 1000}s — Mac speelt waarschijnlijk niet af`);
        trackEndedResolver = null;
        resolve('timeout');
      }
    }, maxMs);
  });
}

export async function stop() {
  currentTrack = null;
  if (trackEndedResolver) {
    trackEndedResolver('stopped');
    trackEndedResolver = null;
  }
  if (server) {
    await new Promise(resolve => server.close(resolve));
    server = null;
    log('HTTP-server gestopt');
  }
}

export async function getState() {
  return currentTrack ? 'playing' : 'stopped';
}
