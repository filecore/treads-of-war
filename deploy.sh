#!/bin/bash
# deploy.sh — copy built game to staging, then rsync everything to the LAN games server.
# Self-heal: strip Windows CR characters if script was saved with CRLF endings
sed -i 's/\r//' "$0" 2>/dev/null || true
set -e

GAME_NAME="$(basename "$(pwd)" | tr -d '\r')"
GAMES_ROOT="/mnt/c/Users/JasonTogneri/games"
DEST="${GAMES_ROOT}/${GAME_NAME}"
REMOTE="oxide@192.168.0.101:/home/oxide/docker/nginx/nginx-subdomain-togneri-games/www-data/games/"

# ── 1. Stage game files locally ───────────────────────────────────────────────
mkdir -p "${DEST}"
rsync -av --delete src/ "${DEST}/"
if [ -d data ]; then
  mkdir -p "${DEST}/data"
  rsync -av data/ "${DEST}/data/"
fi
if [ -f thumbnail.png ]; then
  cp thumbnail.png "${DEST}/thumbnail.png"
fi

echo ""
echo "Staged to ${DEST}"

# ── 2. Push entire games directory (including manifest.json) to remote ────────
echo ""
echo "Syncing to remote server..."
rsync -av --delete "${GAMES_ROOT}/" "${REMOTE}"

echo ""
echo "Done. ${GAME_NAME} + manifest.json live on remote."
