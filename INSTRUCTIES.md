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

## Wat Stijn al heeft gedaan

✅ Max toegevoegd als collaborator op de repo. Max krijgt een GitHub-invite per mail/notificatie. **Accepteer die eerst** vóór je verder gaat met onderstaande stappen.

(Supabase + store-creds staan al ingevuld in stap 4 hieronder. De anon-key is publiek-veilig: zelfde sleutel als die de webapp `app.kaires.nl` in z'n JS bundle ship — RLS doet de echte access control.)

---

## Wat Max op de Pi doet (10 minuten)

Eén keer SSH'en, daarna copy-paste van de blokken hieronder.

### 1. Verbinden met de Pi

```bash
ssh kai@kai.local
```

### 2. Bestaande Python-server uitzetten + Node.js + GitHub CLI installeren

```bash
# Python-server killen
pkill -f 'http.server 8000' || true

# Node.js 20 + git + gh
sudo apt update
sudo apt install -y git curl ca-certificates

# Node.js 20 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# GitHub CLI via official repo
(type -p wget >/dev/null || (sudo apt install wget -y)) \
  && sudo mkdir -p -m 755 /etc/apt/keyrings \
  && wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
  && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && sudo apt update \
  && sudo apt install -y gh

# Verify
node --version    # moet v20.x zijn
npm --version
gh --version
```

### 3. GitHub-auth + repo clonen

```bash
# Login met je GitHub-account (browser-flow, kopieer de one-time code)
gh auth login --web --git-protocol https
# Kies: GitHub.com → HTTPS → "Login with a web browser" → plak de code in de browser

# Clone de repo + npm install
cd ~
gh repo clone stinoe21/kaires-pi
cd kaires-pi
npm install
```

### 4. .env vullen

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
SUPABASE_ANON_KEY=sb_publishable_Rj_uMlkI29NecKZB6Sp2kQ_P-L0oMjg

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
> SUPABASE_ANON_KEY=sb_publishable_Rj_uMlkI29NecKZB6Sp2kQ_P-L0oMjg
> KAIRES_HTTP_PORT=8000
> KAIRES_CACHE_DIR=audio-cache
> KAIRES_CACHE_MAX_FILES=20
> EOF
> ```

### 5. Eerste run — eerst test-playlist (geen Supabase nodig)

Bewijst dat de HTTP-server + cache + browser-flow werkt vóór we Supabase erbij betrekken:

```bash
KAIRES_USE_TEST_PLAYLIST=1 npm start
```

Output: `HTTP-server live op poort 8000` + LAN IPs (bv. `http://192.168.5.22:8000/`).

**Op MacBook van Max:** open één van die URLs in Safari/Chrome, of `http://kai.local:8000/`. Klik play (Safari/Chrome blokkeert autoplay bij eerste keer). Je hoort 3 test-tracks achter elkaar.

Als dit werkt → Ctrl+C in de Pi-terminal.

### 6. Live met Supabase

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

In browser: refresh pagina als die nog van stap 5 open staat. Track komt automatisch binnen.

In het admin-dashboard van app.kaires.nl: rij verschijnt in `pilot_heartbeat` met `provider='pi'`.

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
