# Kaires Pi — installatie & uitlevering

Eenmalig opzetten van een nieuwe Raspberry Pi voor uitlevering aan een klant.

**Eindresultaat:** een Pi die je in de doos kunt stoppen, bij de klant op stroom + LAN aansluit, en automatisch verbinding maakt met Supabase. De webapp ziet 'm "Online" verschijnen, en de klant kan in Settings → Speakers het apparaat als afspeel-bron kiezen.

---

## Voorbereiding

Wat je nodig hebt:

- Raspberry Pi 5 (4GB of 8GB)
- High-endurance microSD-kaart, 32GB+ (Samsung Pro Endurance / SanDisk High Endurance / Kingston Industrial)
- USB-C voeding (officieel Pi 5 PSU, 27W)
- Ethernet-kabel (aanbevolen — eenvoudigste keuze bij de klant) OF WiFi-credentials van de klant
- Op je laptop: [Raspberry Pi Imager](https://www.raspberrypi.com/software/) + [Tailscale](https://tailscale.com/) (gratis account)

Wat je per klant uit Supabase / app.kaires nodig hebt voordat je begint:

1. **Store-UUID** — staat in de `stores`-tabel, of in de URL als je een winkel in app.kaires opent.
2. **Pi-auth account** — een dedicated email + password in Supabase Authentication, gekoppeld aan de juiste `store_id` via `store_users`. Beide aanmaken vóór je de Pi in elkaar zet.

---

## Stap 1 — SD-kaart flashen

1. Open Raspberry Pi Imager.
2. **Choose device:** Raspberry Pi 5.
3. **Choose OS:** Raspberry Pi OS Lite (64-bit) — headless, geen desktop.
4. **Choose storage:** je SD-kaart.
5. Klik op het tandwiel ⚙️ (Advanced) en vul in:
   - **Hostname:** `kaires-<klantnaam>` (bijv. `kaires-beautyx`)
   - **Enable SSH:** ✅ aanvinken, kies **"Allow public-key authentication only"** en plak de inhoud van je laptop's `~/.ssh/id_ed25519.pub` (of `~/.ssh/id_rsa.pub`)
   - **Username:** `kaires`
   - **Password:** zet er één (mag random — SSH gebruikt je key, het wachtwoord is alleen voor lokale console-toegang)
   - **Wireless LAN:** klant-SSID + password als je geen ethernet meeneemt; anders laat je 't leeg
   - **Locale:** Europe/Amsterdam, keyboard NL
6. Schrijf de SD-kaart, stop 'm in de Pi, sluit voeding aan.

Eerste boot duurt ~2 minuten.

---

## Stap 2 — Verbinden + repo klaarzetten

Vind het IP van de Pi (op hetzelfde LAN als de Pi):

```bash
ping kaires-<klantnaam>.local
# of check de DHCP-tabel van je router
```

SSH naar de Pi:

```bash
ssh kaires@kaires-<klantnaam>.local
```

Eenmalig de repo binnenhalen. De makkelijkste route is de GitHub CLI (browser-flow):

```bash
sudo apt update && sudo apt install -y git curl gh
gh auth login --web --git-protocol https
# Volg de instructies: kopieer de one-time code, plak in je laptop-browser, autoriseer.

gh repo clone stijnysmit/kaires-pi
cd kaires-pi
```

> **Alternatief:** als je liever met een SSH deploy-key werkt (geen `gh auth` per Pi), zie [docs/deploy-key.md](docs/deploy-key.md). De master-installer ondersteunt beide — hij vereist alleen dat de repo aanwezig is in `~/kaires-pi`.

---

## Stap 3 — Eén commando: master-installer

```bash
bash deploy/setup.sh
```

Het script doet (in deze volgorde, en slaat over wat al klaar is):

| # | Stap | Wat |
|---|------|-----|
| 1 | Basis-packages | `apt install git curl ca-certificates build-essential` |
| 2 | Node.js 20 | NodeSource APT repo + `nodejs` |
| 3 | Tailscale | Installeren + enrollen op tailnet (interactief — vraagt om confirm) |
| 4 | npm install | Dependencies uit `package.json` |
| 5 | `.env` wizard | Vraagt om store-UUID, Pi-auth email/password; bakt productie-Supabase URL/key als default in |
| 6 | systemd + watchdog | Roept `deploy/install.sh` aan: `Restart=always`, network/time-sync wait, hardware-watchdog (`dtparam=watchdog=on`), kernel-watchdog 15s |
|   | Verificatie | Checkt of `kaires-pi.service` daadwerkelijk draait |

Wat je tijdens stap 5 typt:

```
Store UUID: <plak hier de UUID>
Display-naam voor deze winkel (optioneel): Beauty-X
Pi-auth email: pi-beautyx@kaires.nl
Pi-auth password: ********
Supabase URL [https://hdvekzlkopoivvcrwlor.supabase.co]:  ← Enter voor default
Supabase publishable key [sb_publishable_…]:              ← Enter voor default
Output adapter (sonos | lan-http) [sonos]:                ← Enter voor default
```

Bij Tailscale-enroll (stap 3) krijg je een URL — klik 'm aan op je laptop, koppel de Pi aan jouw tailnet, en je hebt remote SSH zelfs als de klant z'n WiFi later switcht.

---

## Stap 4 — Verifiëren in app.kaires

1. Open [app.kaires.nl](https://app.kaires.nl) op je laptop.
2. Selecteer de juiste winkel via de store-switcher.
3. Open **Settings → Speakers** tab.
4. Bij "Speakers in winkel" hoort binnen ~30 seconden te staan: **Online · `<Pi LAN IP>`** (groene stip).
5. Klik op **"Speakers in winkel"** om deze Pi als afspeel-bron te activeren. Dit is een eenmalige actie per winkel — Supabase onthoudt het.

Klaar. Pi mag in de doos.

---

## Bij de klant

1. Pi uit de doos halen, voeding + LAN-kabel (of WiFi al ingevuld) + audio aansluiten.
2. Pi boot ~30 seconden, registreert zich automatisch in Supabase via z'n nieuwe IP, en pakt het afspelen op.
3. Geen actie nodig — alles is gepre-configureerd.

**Stroomuitval-recovery is volautomatisch:**

- Pi 5 boot vanzelf weer op zodra stroom terug is (default firmware-gedrag).
- `systemd` start `kaires-pi.service` opnieuw met `Restart=always`.
- De hardware-watchdog (`dtparam=watchdog=on` + `RuntimeWatchdogSec=15`) reboot de hele Pi als de kernel hangt.
- Audio-bron-keuze blijft staan in `stores.playback_source = 'pi'` — geen handmatige klik nodig in de app na een reboot.

---

## Troubleshooting

### Service draait niet na `setup.sh`

```bash
sudo journalctl -u kaires-pi -n 50 --no-pager
```

Veelvoorkomende oorzaken:

| Logregel | Oorzaak | Fix |
|----------|---------|-----|
| `Invalid login credentials` | Verkeerde Pi-auth email/password | `bash deploy/configure-env.sh` |
| `Geen store DNA gevonden` | Store-UUID klopt niet of geen DNA | Check `stores` + `retailer_music_dna` in Supabase |
| `getaddrinfo ENOTFOUND` | Geen DNS / netwerk | Check ethernet/WiFi |
| `permission denied (RLS)` | Pi-auth user niet gekoppeld aan store_id | Voeg rij toe in `store_users` |

### Pi verschijnt niet "Online" in de app

Wacht 60 seconden — eerste heartbeat duurt even. Daarna in app.kaires klik de ↺ knop in de status-balk om direct te re-querien. Check ook of de `pi_devices`-tabel in Supabase een rij heeft voor jouw `store_id` met recente `last_seen_at`.

### Pi maakt geen geluid

Vergeet niet om in app.kaires bij **Settings → Speakers** op **"Speakers in winkel"** te klikken — anders speelt audio nog via de webapp-browser en niet via de Pi.

### `.env` opnieuw configureren zonder hele setup-script

```bash
cd ~/kaires-pi
bash deploy/configure-env.sh
sudo systemctl restart kaires-pi
```

### Repo updaten met laatste code

```bash
cd ~/kaires-pi
git pull
npm install            # alleen nodig als package.json gewijzigd is
sudo systemctl restart kaires-pi
```

---

## Bestanden in deze repo

| Pad | Doel |
|-----|------|
| [`deploy/setup.sh`](deploy/setup.sh) | Master-installer (één commando voor de hele setup) |
| [`deploy/configure-env.sh`](deploy/configure-env.sh) | Interactieve `.env`-wizard (apart te draaien voor re-config) |
| [`deploy/install.sh`](deploy/install.sh) | Systemd + watchdog stap (wordt door `setup.sh` aangeroepen) |
| [`deploy/kaires-pi.service`](deploy/kaires-pi.service) | systemd unit template |
| [`.env.example`](.env.example) | Template + uitleg per variabele |
| [`INSTRUCTIES.md`](INSTRUCTIES.md) | Dev/test deployment guide (voor de Beauty-X pilot-Pi) |

---

## Non-interactieve installatie (voor automation / batch)

Voor het in een keer uitleveren van meerdere Pi's, kun je de wizard skippen door alle vereiste variabelen vooraf te zetten:

```bash
export KAIRES_STORE_ID="<uuid>"
export KAIRES_STORE_NAME="Klantnaam"
export KAIRES_PI_EMAIL="pi-klant@kaires.nl"
export KAIRES_PI_PASSWORD="<password>"
export KAIRES_OUTPUT="sonos"
bash deploy/setup.sh --non-interactive
```

Tailscale-enroll moet alsnog handmatig (browser-flow), of skip met `--skip-tailscale` en doe het later.
