#!/usr/bin/env bash
# Interactieve wizard die .env vult voor deze Pi.
#
# Vraagt om wat per-klant verschilt (store_id, Pi-auth, output-mode) en bakt
# productie-Supabase URL/key als default in. Bestaande .env-waardes worden
# als default getoond zodat een re-run snel gaat.
#
# Run standalone om .env later bij te werken:
#   bash deploy/configure-env.sh
#
# Non-interactief draaien: pre-set environment variables, vraag wordt
# overgeslagen als de var al gezet is:
#   KAIRES_STORE_ID=... KAIRES_PI_EMAIL=... KAIRES_PI_PASSWORD=... \
#     bash deploy/configure-env.sh --non-interactive

set -euo pipefail

NONINTERACTIVE=0
for arg in "$@"; do
  case "$arg" in
    --non-interactive|-y) NONINTERACTIVE=1 ;;
  esac
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$REPO_DIR/.env"

# Productie-defaults. De anon key is publiek-veilig (zelfde sleutel als die
# de webapp in z'n JS bundle ship); RLS doet access control. Overschrijf
# alleen voor staging/dev.
DEFAULT_SUPABASE_URL="https://hdvekzlkopoivvcrwlor.supabase.co"
DEFAULT_SUPABASE_ANON_KEY="sb_publishable_Rj_uMlkI29NecKZB6Sp2kQ_P-L0oMjg"
DEFAULT_OUTPUT="sonos"

# Laad bestaande .env zodat herhaald uitvoeren snel gaat (huidige waarden = defaults).
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE" 2>/dev/null || true
  set +a
fi

ask() {
  # ask VAR_NAAM "Vraag tekst" "fallback-default"
  local var=$1
  local question=$2
  local fallback=${3:-}
  local current=${!var:-}
  local default="${current:-$fallback}"

  if [[ $NONINTERACTIVE -eq 1 ]]; then
    if [[ -z "$default" ]]; then
      echo "  ✗ Vereist: $var (zet in environment of run interactief)"
      exit 1
    fi
    eval "$var=\"\$default\""
    echo "  $question: $default"
    return
  fi

  local answer
  if [[ -n "$default" ]]; then
    read -r -p "  $question [$default]: " answer
    eval "$var=\"\${answer:-\$default}\""
  else
    read -r -p "  $question: " answer
    eval "$var=\"\$answer\""
  fi
}

ask_secret() {
  local var=$1
  local question=$2
  local current=${!var:-}

  if [[ $NONINTERACTIVE -eq 1 ]]; then
    if [[ -z "$current" ]]; then
      echo "  ✗ Vereist: $var (zet in environment of run interactief)"
      exit 1
    fi
    return
  fi

  local answer
  if [[ -n "$current" ]]; then
    read -r -s -p "  $question (Enter = behoud bestaand): " answer
    echo
    if [[ -n "$answer" ]]; then
      eval "$var=\"\$answer\""
    fi
  else
    read -r -s -p "  $question: " answer
    echo
    eval "$var=\"\$answer\""
  fi
}

echo
echo "════════════════════════════════════════════════════════════════"
echo "  Kaires Pi — configuratie wizard"
echo "════════════════════════════════════════════════════════════════"
echo
echo "Je hebt twee dingen uit de Kaires admin nodig:"
echo "  1. De store-UUID (te vinden in app.kaires of in Supabase 'stores'-tabel)"
echo "  2. De Pi-auth login (email + password die voor deze winkel is aangemaakt"
echo "     in Supabase Authentication, gekoppeld aan deze store_id via store_users)"
echo

ask KAIRES_STORE_ID "Store UUID"
ask KAIRES_STORE_NAME "Display-naam voor deze winkel (optioneel)"
ask KAIRES_PI_EMAIL "Pi-auth email"
ask_secret KAIRES_PI_PASSWORD "Pi-auth password"

ask SUPABASE_URL "Supabase URL" "$DEFAULT_SUPABASE_URL"
ask SUPABASE_ANON_KEY "Supabase publishable key" "$DEFAULT_SUPABASE_ANON_KEY"

ask KAIRES_OUTPUT "Output adapter (sonos | lan-http)" "${KAIRES_OUTPUT:-$DEFAULT_OUTPUT}"

echo
echo "── Samenvatting ────────────────────────────────────────────────"
echo "  Store:      ${KAIRES_STORE_NAME:-(geen naam)} ($KAIRES_STORE_ID)"
echo "  Output:     $KAIRES_OUTPUT"
echo "  Pi-auth:    $KAIRES_PI_EMAIL"
echo "  Supabase:   $SUPABASE_URL"
echo "────────────────────────────────────────────────────────────────"
echo

if [[ $NONINTERACTIVE -eq 0 ]]; then
  read -r -p "Opslaan naar $ENV_FILE? [Y/n]: " confirm
  if [[ "${confirm:-Y}" =~ ^[Nn] ]]; then
    echo "Geannuleerd — .env niet gewijzigd."
    exit 0
  fi
fi

# Backup bestaande .env voor recovery (laatste 1)
if [[ -f "$ENV_FILE" ]]; then
  cp "$ENV_FILE" "$ENV_FILE.bak"
fi

cat > "$ENV_FILE" <<EOF
# Auto-gegenereerd door deploy/configure-env.sh op $(date -Iseconds)
# Bewerken? Run \`bash deploy/configure-env.sh\` of edit handmatig met nano.

# ── Output adapter ────────────────────────────────────────────────────
KAIRES_OUTPUT=$KAIRES_OUTPUT
KAIRES_USE_TEST_PLAYLIST=0

# ── Store identity ────────────────────────────────────────────────────
KAIRES_STORE_ID=$KAIRES_STORE_ID
KAIRES_STORE_NAME=$KAIRES_STORE_NAME

# ── Supabase ──────────────────────────────────────────────────────────
SUPABASE_URL=$SUPABASE_URL
SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY

# ── Pi auth-user ──────────────────────────────────────────────────────
KAIRES_PI_EMAIL=$KAIRES_PI_EMAIL
KAIRES_PI_PASSWORD=$KAIRES_PI_PASSWORD

# ── LAN HTTP server (alleen relevant in lan-http output mode) ─────────
KAIRES_HTTP_PORT=8000
KAIRES_HTTP_BIND=0.0.0.0

# ── Audio cache ───────────────────────────────────────────────────────
KAIRES_CACHE_DIR=audio-cache
KAIRES_CACHE_MAX_FILES=20

# ── Tuning ────────────────────────────────────────────────────────────
KAIRES_PULSE_INTERVAL_MS=60000
KAIRES_TRACK_END_POLL_MS=5000
KAIRES_HEARTBEAT_INTERVAL_MS=30000
KAIRES_APP_VERSION=pi-prod
EOF

chmod 600 "$ENV_FILE"
echo "  ✓ .env opgeslagen ($ENV_FILE, mode 600)"
if [[ -f "$ENV_FILE.bak" ]]; then
  echo "    Vorige versie bewaard in $ENV_FILE.bak"
fi
