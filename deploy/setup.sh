#!/usr/bin/env bash
# Kaires Pi — master installer. Eén commando dat een verse Pi gebruiksklaar
# maakt voor uitlevering aan een klant.
#
# Run dit als de Pi-account user (niet als root), vanuit de geclonete repo:
#   cd ~/kaires-pi
#   bash deploy/setup.sh
#
# Wat dit doet (idempotent — slaat over wat al klaar is):
#   1. apt deps (git, curl, build-essential, ca-certificates)
#   2. Node.js 20 LTS via NodeSource
#   3. Tailscale (optioneel, voor remote support)
#   4. npm install
#   5. .env configuratie via wizard (alleen als .env onvolledig is)
#   6. systemd service + watchdog + network/time-sync wait (via install.sh)
#   7. Verificatie: service draait, Pi-rij verschijnt in Supabase
#
# Non-interactief draaien (bv. via automation):
#   KAIRES_STORE_ID=… KAIRES_PI_EMAIL=… KAIRES_PI_PASSWORD=… \
#     bash deploy/setup.sh --non-interactive

set -euo pipefail

if [[ $EUID -eq 0 ]]; then
  echo "Run dit als de Pi-account user (niet als root) — script gebruikt sudo waar nodig."
  exit 1
fi

NONINTERACTIVE=0
SKIP_TAILSCALE=0
for arg in "$@"; do
  case "$arg" in
    --non-interactive|-y) NONINTERACTIVE=1 ;;
    --skip-tailscale)     SKIP_TAILSCALE=1 ;;
    --help|-h)
      sed -n '2,/^set -euo/p' "$0" | sed 's/^# \?//; s/^set -euo.*$//'
      exit 0
      ;;
  esac
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
cd "$REPO_DIR"

# Sanity: zorg dat we in de juiste repo zitten
if [[ ! -f "$REPO_DIR/src/index.mjs" || ! -f "$REPO_DIR/package.json" ]]; then
  echo "Dit script verwacht dat het draait vanuit de kaires-pi repo root."
  echo "Huidige map: $REPO_DIR — ontbreekt src/index.mjs of package.json."
  exit 1
fi

step() {
  echo
  echo "════════════════════════════════════════════════════════════════"
  echo "  $*"
  echo "════════════════════════════════════════════════════════════════"
}

confirm() {
  # Y default. In non-interactive mode altijd ja.
  if [[ $NONINTERACTIVE -eq 1 ]]; then
    return 0
  fi
  local prompt="${1:-Doorgaan?}"
  local answer
  read -r -p "$prompt [Y/n]: " answer
  [[ ! "${answer:-Y}" =~ ^[Nn] ]]
}

# ── 1. Basis-packages ─────────────────────────────────────────────────
step "1/6 Basis-packages (git, curl, build-essential)"
NEED_APT=0
for pkg in git curl ca-certificates; do
  if ! command -v "$pkg" >/dev/null 2>&1; then
    NEED_APT=1
    break
  fi
done
if [[ $NEED_APT -eq 1 ]]; then
  sudo apt update
  sudo apt install -y git curl ca-certificates build-essential
else
  echo "  ✓ al geïnstalleerd"
fi

# ── 2. Node.js 20 ────────────────────────────────────────────────────
step "2/6 Node.js 20 LTS"
if command -v node >/dev/null 2>&1 && node --version | grep -qE '^v(2[0-9]|[3-9][0-9])\.'; then
  echo "  ✓ Node $(node --version) al aanwezig"
else
  echo "  → Installeren via NodeSource…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
  echo "  ✓ $(node --version) geïnstalleerd"
fi

# ── 3. Tailscale (remote support) ────────────────────────────────────
step "3/6 Tailscale (remote SSH-toegang voor support na uitlevering)"
if [[ $SKIP_TAILSCALE -eq 1 ]]; then
  echo "  → overgeslagen (--skip-tailscale)"
elif command -v tailscale >/dev/null 2>&1; then
  echo "  ✓ Tailscale al geïnstalleerd"
else
  if confirm "Tailscale installeren? (sterk aangeraden — gratis, geeft remote SSH zonder port-forward)"; then
    curl -fsSL https://tailscale.com/install.sh | sh
    echo "  ✓ Tailscale geïnstalleerd"
  else
    echo "  → overgeslagen (kan later met: curl -fsSL https://tailscale.com/install.sh | sh)"
  fi
fi

# Enroll de Pi op het tailnet als 'ie nog niet up is.
if command -v tailscale >/dev/null 2>&1 && ! sudo tailscale status >/dev/null 2>&1; then
  if confirm "Pi nu enrollen op tailnet? Browser-link volgt — klik 'm aan op je laptop"; then
    sudo tailscale up --ssh || echo "  → enroll niet afgerond (kan later met: sudo tailscale up --ssh)"
  fi
fi

# ── 4. NPM dependencies ──────────────────────────────────────────────
step "4/6 NPM dependencies"
if [[ -d node_modules && -f node_modules/.package-lock.json ]]; then
  echo "  ✓ node_modules aanwezig (run 'npm install' handmatig om te updaten)"
else
  npm install
  echo "  ✓ dependencies geïnstalleerd"
fi

# ── 5. .env configuratie ─────────────────────────────────────────────
step "5/6 .env configuratie"

# Laad bestaande .env-waarden zodat we kunnen detecteren wat nog mist
KAIRES_STORE_ID_LOADED=""
KAIRES_PI_EMAIL_LOADED=""
KAIRES_PI_PASSWORD_LOADED=""
if [[ -f "$REPO_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$REPO_DIR/.env" 2>/dev/null || true
  set +a
  KAIRES_STORE_ID_LOADED="${KAIRES_STORE_ID:-}"
  KAIRES_PI_EMAIL_LOADED="${KAIRES_PI_EMAIL:-}"
  KAIRES_PI_PASSWORD_LOADED="${KAIRES_PI_PASSWORD:-}"
fi

WIZARD_ARGS=()
if [[ $NONINTERACTIVE -eq 1 ]]; then
  WIZARD_ARGS+=(--non-interactive)
fi

if [[ -z "$KAIRES_STORE_ID_LOADED" || -z "$KAIRES_PI_EMAIL_LOADED" || -z "$KAIRES_PI_PASSWORD_LOADED" ]]; then
  echo "  → .env onvolledig of ontbreekt — start config-wizard…"
  bash "$SCRIPT_DIR/configure-env.sh" "${WIZARD_ARGS[@]}"
else
  echo "  ✓ .env compleet — store=$KAIRES_STORE_ID_LOADED, pi-auth=$KAIRES_PI_EMAIL_LOADED"
  if [[ $NONINTERACTIVE -eq 0 ]]; then
    read -r -p "  Toch opnieuw configureren? [y/N]: " redo
    if [[ "${redo:-N}" =~ ^[YyJj] ]]; then
      bash "$SCRIPT_DIR/configure-env.sh" "${WIZARD_ARGS[@]}"
    fi
  fi
fi

# ── 6. Systemd + watchdog ────────────────────────────────────────────
step "6/6 Systemd service + watchdog"
bash "$SCRIPT_DIR/install.sh"

# ── Verificatie ──────────────────────────────────────────────────────
step "Verificatie"

# Geef de service een paar seconden om op te komen (signin + register).
sleep 4

if sudo systemctl is-active --quiet kaires-pi.service; then
  echo "  ✓ kaires-pi.service draait (active)"
else
  echo "  ✗ Service is NIET actief — laatste logregels:"
  sudo journalctl -u kaires-pi --no-pager -n 30 | sed 's/^/      /'
  echo
  echo "  Hint: gebruik 'sudo journalctl -u kaires-pi -f' om live mee te kijken."
  exit 1
fi

# Probeer LAN-IP te tonen voor de operator
LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"

echo
echo "════════════════════════════════════════════════════════════════"
echo "  ✓ Kaires-box is gebruiksklaar"
echo "════════════════════════════════════════════════════════════════"
echo
[[ -n "$LAN_IP" ]] && echo "  Pi LAN IP:  $LAN_IP"
[[ -n "${KAIRES_STORE_ID:-}" ]] && echo "  Store-ID:   $KAIRES_STORE_ID"
echo "  Service:    kaires-pi.service (active, auto-restart, watchdog aan)"
echo
echo "  Volgende stappen:"
echo "    1. In app.kaires (Settings → Speakers) → klik 'Speakers in winkel'"
echo "       Dit zet de afspeel-bron op deze Pi (eenmalig per winkel)."
echo "    2. Pi naar de klant, voeding + audio aansluiten."
echo "    3. Stroomuitval-recovery is automatisch: systemd + hardware-watchdog."
echo
echo "  Live logs:  sudo journalctl -u kaires-pi -f"
echo "  Status:     sudo systemctl status kaires-pi"
echo "  Re-config:  bash deploy/configure-env.sh"
echo
