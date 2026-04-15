#!/bin/bash
# deploy.sh — push to GitHub, rsync src/ and relay/ to your server, rebuild relay container.
# Self-heal: strip Windows CR characters if script was saved with CRLF endings
sed -i 's/\r//' "$0" 2>/dev/null || true
set -e

CONFIG_FILE="$(dirname "$0")/.deploy.conf"

# ── Load or prompt for config ──────────────────────────────────────────────
if [ ! -f "$CONFIG_FILE" ]; then
  echo "First run: no deployment config found."
  echo "Enter your server details below. These will be saved to .deploy.conf (gitignored)."
  echo ""
  read -p "SSH user@host (e.g. user@192.0.2.10): " SSH_HOST
  read -p "Remote web root path (e.g. /home/user/docker/nginx/treads/www-data/treads/): " REMOTE_WEB_ROOT
  read -p "Remote relay directory (e.g. /home/user/docker/nginx/treads/relay): " REMOTE_RELAY_DIR
  read -p "Remote Docker Compose directory (e.g. /home/user/docker/nginx/treads): " REMOTE_COMPOSE_DIR
  read -p "Relay service name in docker-compose.yml (e.g. relay): " RELAY_SERVICE
  read -p "Domain name (display only, e.g. treads.example.com): " DOMAIN

  cat > "$CONFIG_FILE" <<EOF
SSH_HOST="$SSH_HOST"
REMOTE_WEB_ROOT="$REMOTE_WEB_ROOT"
REMOTE_RELAY_DIR="$REMOTE_RELAY_DIR"
REMOTE_COMPOSE_DIR="$REMOTE_COMPOSE_DIR"
RELAY_SERVICE="$RELAY_SERVICE"
DOMAIN="$DOMAIN"
EOF
  echo ""
  echo "Config saved to .deploy.conf"
  echo ""
fi

source "$CONFIG_FILE"

# ── 0. Push to GitHub ──────────────────────────────────────────────────────
echo ""
echo "Pushing to GitHub..."
git push
echo "GitHub updated."

# ── 1. Sync game files to server ──────────────────────────────────────────
echo ""
echo "Syncing to ${DOMAIN}..."
# --checksum avoids WSL2 mtime issues when files are edited on a Windows-mounted drive
rsync -av --checksum --delete src/ "${SSH_HOST}:${REMOTE_WEB_ROOT}"

# ── 1b. Sync treaducation to server ───────────────────────────────────────
if [ -d treaducation ]; then
  echo ""
  echo "Syncing treaducation..."
  TREADUCATION_REMOTE="${REMOTE_WEB_ROOT%treads/}treaducation/"
  rsync -av --checksum --delete treaducation/ "${SSH_HOST}:${TREADUCATION_REMOTE}"
fi

echo ""
echo "Done. ${DOMAIN} updated."

# ── 2. Deploy relay server (only if relay/ directory exists) ──────────────
if [ -d relay ]; then
  echo ""
  echo "Deploying relay server..."
  rsync -av relay/ "${SSH_HOST}:${REMOTE_RELAY_DIR}/"
  ssh "${SSH_HOST}" \
    "cd ${REMOTE_COMPOSE_DIR} && docker compose up -d --build ${RELAY_SERVICE} 2>&1 | tail -5"
  echo "Relay deployed."
fi
