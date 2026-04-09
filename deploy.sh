#!/bin/bash
# deploy.sh — rsync src/ and relay/ to the server, then rebuild the relay container.
# Self-heal: strip Windows CR characters if script was saved with CRLF endings
sed -i 's/\r//' "$0" 2>/dev/null || true
set -e

TREADS_REMOTE="user@your-server:/home/user/docker/treads/www-data/treads/"

# ── 1. Push game + zip to treads.example.com ──────────────────────────────────
echo ""
echo "Syncing to treads.example.com..."
rsync -av --delete src/ "${TREADS_REMOTE}"
for zipfile in treads_of_war_source_v*.zip; do
  [ -f "$zipfile" ] && scp "$zipfile" "user@your-server:/home/user/docker/treads/www-data/treads/"
done

echo ""
echo "Done. treads.example.com updated."

# ── 2. Deploy relay server to treads subdomain (only if relay/ exists) ────────
RELAY_REMOTE_DIR="/home/user/docker/treads/relay"
if [ -d relay ]; then
  echo ""
  echo "Deploying relay server..."
  rsync -av relay/ "user@your-server:${RELAY_REMOTE_DIR}/"
  ssh user@your-server \
    "cd /home/user/docker/treads && docker compose up -d --build relay 2>&1 | tail -5"
  echo "Relay deployed."
fi
