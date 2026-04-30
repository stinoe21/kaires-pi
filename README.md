# kaires-pi

Silent worker voor Kaires-curatie op Raspberry Pi. Draait de CAS-engine en stuurt tracks naar de configureerbare audio-output (Sonos UPnP, ALSA, generieke DLNA).

## Architectuur in één plaatje

```
                  ┌─────────────────────────┐
                  │  Vercel webapp + admin  │  app.kaires.nl
                  │       (dashboard)       │
                  └────────────┬────────────┘
                               │  read/write
                  ┌────────────▼────────────┐
                  │    Supabase (hub)       │  tracks, playlist_log,
                  │                          │  pilot_heartbeat, DNA
                  └────────────┬────────────┘
                               │  poll + write
                  ┌────────────▼────────────┐
                  │     Pi runtime           │  60s pulse → CAS → query
                  │     (this repo)          │  → setAVTransportURI
                  └────────────┬────────────┘
                               │  UPnP / ALSA / DLNA
                  ┌────────────▼────────────┐
                  │      Audio output        │  Sonos / DAC HAT / etc.
                  └─────────────────────────┘
```

Geen UI op de Pi. Geen login. Alleen SSH via Tailscale voor remote ops.

## Output adapters

`KAIRES_OUTPUT` env var bepaalt welke adapter actief is:

| Waarde | Doel | Status |
|---|---|---|
| `sonos` | UPnP `SetAVTransportURI` naar groepscoordinator | MVP |
| `alsa` | ffplay → DAC HAT → AUX | later |
| `dlna` | generieke UPnP MediaRenderer (Denon/Yamaha) | later |

## Fase-1 scripts (validatie)

Vóór de echte runtime: drie onafhankelijke scripts om te bewijzen dat het UPnP-pad werkt.

```bash
npm install

# 1. Vind alle Sonos devices in het LAN
npm run discover

# 2. Praat met device — zet volume, lees terug, herstel (geen audio)
npm run sanity

# 3. Speel een test-MP3 af, polled tot STOPPED
npm run play-test
```

Multicast geblokkeerd? Zet `KAIRES_SONOS_HINT_IP=<sonos-ip>` in je `.env` en de scripts skippen SSDP.

## Setup

Zie [`SETUP.md`](./SETUP.md) voor Pi flash, Node 20, Tailscale, deploy key, eerste run.

## Repo-keuze

Pi-code zit bewust in een aparte repo, niet in de webapp:
- Andere deploy-target (Pi vs Vercel)
- Andere lifecycle (silent worker vs SPA)
- Andere security-model (LAN vs internet)

Gedeelde logica (CAS-engine, library-query) gaat in een toekomstige npm package zodra duplicatie pijn doet.
