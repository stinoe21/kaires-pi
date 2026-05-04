#!/usr/bin/env bash
# Idempotent installer voor de kaires-pi systemd service.
#
# Wat dit doet:
#   1. Installeert /etc/systemd/system/kaires-pi.service (Restart=always,
#      geen geef-op-limiet, wacht op network-online).
#   2. Enables systemd-networkd-wait-online zodat boot wacht tot het LAN er is —
#      anders crasht Sonos discovery direct na power-on.
#   3. Patcht /etc/systemd/system.conf via drop-in met RuntimeWatchdogSec=15:
#      systemd kicked zichzelf, en als kernel hangt reboot de hardware-watchdog
#      automatisch (mits Pi watchdog enabled — zie stap 4).
#   4. Voegt dtparam=watchdog=on toe aan /boot/firmware/config.txt (Pi 5) of
#      /boot/config.txt (oudere) als 't er nog niet staat.
#   5. daemon-reload + enable + restart.
#
# Veilig om vaker te draaien: skip stappen die al gedaan zijn.

set -euo pipefail

if [[ $EUID -eq 0 ]]; then
  echo "Run dit als de account-user (niet als root) — script gebruikt sudo waar nodig."
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
SERVICE_TEMPLATE="$SCRIPT_DIR/kaires-pi.service"
SERVICE_DST="/etc/systemd/system/kaires-pi.service"

if [[ ! -f "$SERVICE_TEMPLATE" ]]; then
  echo "Kan $SERVICE_TEMPLATE niet vinden. Run dit script vanuit de kaires-pi repo (deploy/install.sh)."
  exit 1
fi

# Sanity: zorg dat de runtime daadwerkelijk in $HOME/kaires-pi staat
if [[ ! -f "$HOME/kaires-pi/src/index.mjs" ]]; then
  echo "Verwacht $HOME/kaires-pi/src/index.mjs — repo niet daar geclonet?"
  exit 1
fi
if [[ ! -f "$HOME/kaires-pi/.env" ]]; then
  echo "Verwacht $HOME/kaires-pi/.env — kopieer .env.example en vul KAIRES_PI_EMAIL/PASSWORD/etc in."
  exit 1
fi

echo "==> 1/5 systemd unit installeren (User=$USER, WorkingDirectory=$HOME/kaires-pi)"
TMP_UNIT="$(mktemp)"
sed -e "s|__USER__|$USER|g" -e "s|__HOME__|$HOME|g" "$SERVICE_TEMPLATE" > "$TMP_UNIT"
sudo install -m 644 "$TMP_UNIT" "$SERVICE_DST"
rm -f "$TMP_UNIT"

echo "==> 2/5 network-online wait inschakelen"
sudo systemctl enable systemd-networkd-wait-online.service >/dev/null 2>&1 || \
  sudo systemctl enable NetworkManager-wait-online.service >/dev/null 2>&1 || \
  echo "    (geen network-online unit gevonden — sla over)"

echo "==> 3/5 RuntimeWatchdogSec=15 via drop-in"
sudo mkdir -p /etc/systemd/system.conf.d
sudo tee /etc/systemd/system.conf.d/10-watchdog.conf >/dev/null <<'EOF'
[Manager]
RuntimeWatchdogSec=15
ShutdownWatchdogSec=2min
EOF

echo "==> 4/5 hardware watchdog (dtparam=watchdog=on)"
CONFIG_TXT=""
if [[ -f /boot/firmware/config.txt ]]; then
  CONFIG_TXT=/boot/firmware/config.txt
elif [[ -f /boot/config.txt ]]; then
  CONFIG_TXT=/boot/config.txt
fi
if [[ -n "$CONFIG_TXT" ]]; then
  if grep -qE '^[[:space:]]*dtparam=watchdog=on' "$CONFIG_TXT"; then
    echo "    al aanwezig in $CONFIG_TXT"
  else
    echo "dtparam=watchdog=on" | sudo tee -a "$CONFIG_TXT" >/dev/null
    echo "    toegevoegd aan $CONFIG_TXT (actief na volgende reboot)"
  fi
else
  echo "    geen config.txt gevonden — sla over"
fi

echo "==> 5/5 daemon-reload + enable + restart"
sudo systemctl daemon-reload
sudo systemctl enable kaires-pi.service
sudo systemctl restart kaires-pi.service

echo
echo "Klaar. Status:"
sudo systemctl --no-pager --full status kaires-pi.service | head -20 || true
echo
echo "Live logs:  sudo journalctl -u kaires-pi -f"
echo "Reboot test: sudo reboot   (na boot moet kaires-pi vanzelf draaien)"
