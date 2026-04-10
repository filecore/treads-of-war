#!/bin/bash
# deploy.sh — rsync src/ and relay/ to the server, then rebuild the relay container.
# Self-heal: strip Windows CR characters if script was saved with CRLF endings
sed -i 's/\r//' "$0" 2>/dev/null || true
set -e

TREADS_REMOTE="oxide@192.168.0.101:/home/oxide/docker/nginx/nginx-subdomain-togneri-treads/www-data/treads/"

# ── 1. Push game + zip to treads.togneri.net/treads/ ─────────────────────────
echo ""
echo "Syncing to treads.togneri.net/treads/..."
# Use --checksum to avoid WSL2 mtime issues when files are edited on the
# Windows-mounted drive (/mnt/c/).
rsync -av --checksum --delete src/ "${TREADS_REMOTE}"
for zipfile in treads_of_war_source_v*.zip; do
  [ -f "$zipfile" ] && scp "$zipfile" "oxide@192.168.0.101:/home/oxide/docker/nginx/nginx-subdomain-togneri-treads/www-data/treads/"
done

echo ""
echo "Done. treads.togneri.net updated."

# ── 2. Deploy relay server to treads subdomain (only if relay/ exists) ────────
RELAY_REMOTE_DIR="/home/oxide/docker/nginx/nginx-subdomain-togneri-treads/relay"
if [ -d relay ]; then
  echo ""
  echo "Deploying relay server..."
  rsync -av relay/ "oxide@192.168.0.101:${RELAY_REMOTE_DIR}/"
  ssh oxide@192.168.0.101 \
    "cd /home/oxide/docker/nginx/nginx-subdomain-togneri-treads && docker compose up -d --build relay 2>&1 | tail -5"
  echo "Relay deployed."
fi
