# Live deployment — Pi → MacBook test-stream

Eénmalige setup om de Pi (`kai`) data uit Supabase te laten halen, lokaal te cachen, en de MacBook van Max via browser te laten afspelen.

---

## Wat dit doet

```
Supabase  ──signed URL──►  Pi (downloadt + cachet)
                            │
                            ▼
                    HTTP server :8000
                            │
                            ▼ kai.local:8000/
                          Mac browser  ───►  speakers
```

- Pi runt onze runtime (`npm start`) met `KAIRES_OUTPUT=lan-http`
- Pulse-loop: Supabase → cache → adapter → API
- Browser doet `<audio>` playback, fired `track-ended` ack zodat Pi weet wanneer volgende track ingeladen mag worden

---

## Wat Stijn vooraf doet (1 minuut)

**Deploy key toevoegen wanneer Max die in stap 3 stuurt.**

Wanneer Max in stap 3 z'n public key naar je stuurt: ga naar https://github.com/stinoe21/kaires-pi/settings/keys → **Add deploy key** → titel `kai-pi-01`, paste pubkey, **read access only** (geen write), Add key.

(Supabase + store-creds staan al ingevuld in stap 5 hieronder. De anon-key is publiek-veilig: zelfde sleutel als die de webapp `kaires.com` in z'n JS bundle ship — RLS doet de echte access control.)

---

## Wat Max op de Pi doet (10 minuten)

Eén keer SSH'en, daarna copy-paste van de blokken hieronder.

### 1. Verbinden met de Pi

```bash
ssh kai@kai.local
```

### 2. Bestaande Python-server uitzetten + Node.js installeren

```bash
# Python-server killen
pkill -f 'http.server 8000' || true

# Node.js 20 + git
sudo apt update
sudo apt install -y git curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version    # moet v20.x zijn
npm --version
```

### 3. SSH deploy key voor GitHub

```bash
ssh-keygen -t ed25519 -f ~/.ssh/github_deploy -N "" -C "kai-pi-01"

# Configure SSH om deze key te gebruiken voor github.com
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/github_deploy
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config

# Toon de pubkey — stuur deze naar Stijn via signal/whatsapp:
cat ~/.ssh/github_deploy.pub
```

**Stop hier tot Stijn de key heeft toegevoegd in GitHub.** Dat duurt < 1 min.

### 4. Repo clonen + dependencies

```bash
# Test of de deploy key werkt
ssh -T git@github.com
# Verwacht: "Hi stinoe21/kaires-pi! You've successfully authenticated..."

cd ~
git clone git@github.com:stinoe21/kaires-pi.git
cd kaires-pi
npm install
```

### 5. .env vullen

```bash
cp .env.example .env
nano .env
```

Vul deze blok onderaan / aan (overschrijft de defaults waar nodig):

```env
KAIRES_OUTPUT=lan-http
KAIRES_USE_TEST_PLAYLIST=0

KAIRES_STORE_ID=31ca6e56-0f24-4b5b-897a-2a1b1c73f4f5
KAIRES_STORE_NAME=Beauty-X (Pi-test)

SUPABASE_URL=https://hdvekzlkopoivvcrwlor.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhkdmVremxrb3BvaXZ2Y3J3bG9yIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEzNjI1NDksImV4cCI6MjA4NjkzODU0OX0.AMNMhG0sW7lchf0P8fSWnFOdFpx-ZoXM8NwrugozMEA

KAIRES_HTTP_PORT=8000
KAIRES_CACHE_DIR=audio-cache
KAIRES_CACHE_MAX_FILES=20
```

Save & exit (Ctrl+O, Enter, Ctrl+X).

> **Sneller alternatief** — vervang de hele inhoud in één commando i.p.v. nano:
>
> ```bash
> cat > .env <<'EOF'
> KAIRES_OUTPUT=lan-http
> KAIRES_USE_TEST_PLAYLIST=0
> KAIRES_STORE_ID=31ca6e56-0f24-4b5b-897a-2a1b1c73f4f5
> KAIRES_STORE_NAME=Beauty-X (Pi-test)
> SUPABASE_URL=https://hdvekzlkopoivvcrwlor.supabase.co
> SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhkdmVremxrb3BvaXZ2Y3J3bG9yIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEzNjI1NDksImV4cCI6MjA4NjkzODU0OX0.AMNMhG0sW7lchf0P8fSWnFOdFpx-ZoXM8NwrugozMEA
> KAIRES_HTTP_PORT=8000
> KAIRES_CACHE_DIR=audio-cache
> KAIRES_CACHE_MAX_FILES=20
> EOF
> ```

### 6. Eerste run — eerst test-playlist (geen Supabase nodig)

Bewijst dat de HTTP-server + cache + browser-flow werkt vóór we Supabase erbij betrekken:

```bash
KAIRES_USE_TEST_PLAYLIST=1 npm start
```

Output: `HTTP-server live op poort 8000` + LAN IPs (bv. `http://192.168.5.22:8000/`).

**Op MacBook van Max:** open één van die URLs in Safari/Chrome, of `http://kai.local:8000/`. Klik play (Safari/Chrome blokkeert autoplay bij eerste keer). Je hoort 3 test-tracks achter elkaar.

Als dit werkt → Ctrl+C in de Pi-terminal.

### 7. Live met Supabase

```bash
npm start
```

(Zonder env-prefix — leest `KAIRES_USE_TEST_PLAYLIST=0` uit `.env`.)

Output zou moeten zijn:
```
[runtime] Bootstrap — config: {"output":"lan-http","mode":"library",...}
[lan-http] HTTP-server live op poort 8000
[lan-http] Open in browser: → http://192.168.5.22:8000/
[heartbeat] Start (30s interval, host=Kai)
[runtime] Library-mode voor store 31ca6e56-...
[runtime] DNA geladen: Beauty-X
[runtime] Pulse → <Artist> - <Title> (CAS=0.62)
[cache]   MISS <id>.mp3 — download van https://hdvekzlkopoivvcrwlor.supabase.co/...
[cache]   Klaar in 850ms → <id>.mp3
[lan-http] Queued: <Artist> — <Title>
```

In browser: refresh pagina als die nog van stap 6 open staat. Track komt automatisch binnen.

In het admin-dashboard van kaires.com: rij verschijnt in `pilot_heartbeat` met `provider='pi'`.

---

## Troubleshooting

### "permission denied" bij Supabase queries

RLS-policies blokkeren anon-key. Stijn moet checken op:
- `tracks` (SELECT public)
- `retailer_music_dna` (SELECT voor Beauty-X store_id)
- `realtime_context` (SELECT voor Beauty-X store_id)
- `playlist_log` (INSERT met `store_id` match)
- `pilot_heartbeat` (INSERT met `store_id` match, `user_id=null`)

### Browser hoort niets

- Klik manueel play (autoplay-blocker)
- Check of `<audio>` element een src heeft (devtools)
- Check dat `/audio/<id>.mp3` 200 OK retourneert (devtools network tab)

### `kai.local` resolved niet op Mac

- Werkt alleen op echte Wi-Fi met Bonjour (`AI AM` ja, iPhone-hotspot nee)
- Anders: gebruik IP direct (`192.168.5.22`)

### "Geen DNA voor store" warning

Beauty-X heeft DNA in `retailer_music_dna`. Als deze niet komt: RLS-issue (zie boven), of verkeerd store_id.

### Track download faalt met HTTP 401

Supabase signed URL is verlopen of file_path klopt niet. Check `getSignedUrl` in `src/library.mjs` — TTL is 24u, dat zou genoeg moeten zijn.

---

## Volgende stappen na succesvolle run

1. **systemd service** — Pi start runtime automatisch na reboot. Documented in `SETUP.md` sectie 7.
2. **Tailscale** — remote SSH toegang van Stijn's laptop naar Pi (zie SETUP.md sectie 3).
3. **Sonos-pad** — switch `KAIRES_OUTPUT=sonos` zodra een Sonos op LAN beschikbaar is. Geen code-changes meer nodig.
4. **Eigen Pi-PSU** — voorkomt under-voltage throttle (per Max's handoff).
