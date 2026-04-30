# Pi setup

Eenmalig opzetten van een Raspberry Pi 5 om kaires-pi te draaien.

## Wat je nodig hebt

- Raspberry Pi 5 (4GB of 8GB)
- High-endurance microSD (Samsung Pro Endurance / SanDisk High Endurance / Kingston Industrial), 32GB+
- USB-C voeding (officieel Pi 5 PSU, 27W)
- Ethernet of WiFi-toegang
- Op je laptop: [Raspberry Pi Imager](https://www.raspberrypi.com/software/), [Tailscale account](https://tailscale.com/) (gratis)

---

## 1. Flashen

1. Open Raspberry Pi Imager
2. **Choose device:** Raspberry Pi 5
3. **Choose OS:** Raspberry Pi OS Lite (64-bit) — geen desktop, headless
4. **Choose storage:** je SD-kaart
5. Klik tandwiel ⚙️ (advanced):
   - Hostname: `kaires-pi-01`
   - Enable SSH: aanvinken, **public-key only** (plak je laptop's `~/.ssh/id_ed25519.pub` of `~/.ssh/id_rsa.pub`)
   - Username: `kaires`
   - Password: zet er één maar gebruik 'm nooit (SSH gebruikt key)
   - Wireless LAN: jouw thuis-SSID + password (voor eerste boot — bij Beauty-X verbinden we via ethernet of swap)
   - Locale: Europe/Amsterdam, keyboard NL
6. Schrijf de SD-kaart, stop 'm in de Pi, sluit voeding aan.

Eerste boot duurt ~2 minuten. Pi pakt z'n IP via DHCP.

---

## 2. Eerste SSH-verbinding

Vind het IP van de Pi:
```bash
# vanaf je laptop, op hetzelfde netwerk:
ping kaires-pi-01.local
# of check je router's DHCP-tabel
```

Login:
```bash
ssh kaires@kaires-pi-01.local
```

Update + basics:
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl build-essential
```

---

## 3. Tailscale (remote SSH zonder port-forward)

Op de Pi:
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh
```

De `--ssh` flag laat Tailscale SSH-auth via je Tailscale-identity doen (geen extra keys nodig). Volg de URL die getoond wordt om de Pi aan je tailnet te koppelen.

Test vanaf je laptop (ook ingelogd in zelfde tailnet):
```bash
tailscale status              # Pi moet zichtbaar zijn
ssh kaires@kaires-pi-01      # Tailscale routeert
```

Vanaf nu kun je vanaf elk netwerk de Pi bereiken zolang Tailscale draait.

---

## 4. Node.js 20

Op de Pi:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version    # moet v20.x zijn
npm --version
```

---

## 5. Repo clonen via deploy key

Read-only toegang vanaf de Pi naar GitHub.

Op de Pi:
```bash
ssh-keygen -t ed25519 -C "kaires-pi-01" -f ~/.ssh/github_deploy -N ""
cat ~/.ssh/github_deploy.pub
```

Plak die pubkey in **GitHub repo → Settings → Deploy keys → Add deploy key** (read access, geen write).

Configureer SSH om deze key te gebruiken voor github.com:
```bash
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/github_deploy
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
```

Clone:
```bash
cd ~
git clone git@github.com:stijnysmit/kaires-pi.git
cd kaires-pi
npm install
```

---

## 6. Eerste validatie (Fase-1)

In de repo op de Pi:
```bash
cp .env.example .env
nano .env      # optioneel KAIRES_SONOS_HINT_IP invullen als SSDP faalt
```

Discovery — moet alle Sonos devices in het LAN tonen:
```bash
npm run discover
```

Sanity — zet volume op 20, leest terug, herstelt (geen audio):
```bash
npm run sanity
```

Play-test — speelt 30s test-MP3 af:
```bash
npm run play-test
```

Als alle drie groen zijn: Pi → UPnP → Sonos werkt. Klaar voor de echte runtime.

---

## 7. Systemd service (later, vóór productie)

Wanneer de runtime in `src/index.mjs` af is:

```bash
sudo tee /etc/systemd/system/kaires-pi.service <<'EOF'
[Unit]
Description=Kaires Pi runtime
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=kaires
WorkingDirectory=/home/kaires/kaires-pi
ExecStart=/usr/bin/node src/index.mjs
EnvironmentFile=/home/kaires/kaires-pi/.env
Restart=on-failure
RestartSec=5
WatchdogSec=30

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable kaires-pi
sudo systemctl start kaires-pi
sudo journalctl -u kaires-pi -f    # live logs
```

Hardware watchdog (recovery bij kernel hang):
```bash
sudo nano /etc/systemd/system.conf
# zet:
RuntimeWatchdogSec=15
```

---

## Iteratie-workflow

Vanaf laptop:
```bash
# edit code lokaal, commit + push
git push origin main
```

Op de Pi:
```bash
cd ~/kaires-pi
git pull
sudo systemctl restart kaires-pi
```

Voor snelle iteratie: stop de service, run handmatig met `node src/index.mjs`, restart wanneer 't werkt.
