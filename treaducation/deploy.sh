#!/bin/bash
# deploy.sh — build treaducation.zip and push everything to treads.example.com/treaducation/
sed -i 's/\r//' "$0" 2>/dev/null || true
set -e

REMOTE="user@your-server:/home/user/docker/treads/www-data/treaducation/"
LANDING_REMOTE="user@your-server:/home/user/docker/treads/www-data/index.html"
LANDING_LOCAL="/mnt/c/Users/JasonTogneri/games/games/index.html"

# ── 1. Create the downloadable zip ───────────────────────────────────────────
echo ""
echo "Building treaducation.zip..."
python3 -c "
import zipfile, os
files = [
    'step1-hello-world.html',
    'step2-terrain.html',
    'step3-tank.html',
    'step4-shoot.html',
    'step5-1v1.html',
    'README.md',
]
with zipfile.ZipFile('treaducation.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    for f in files:
        if os.path.exists(f):
            z.write(f)
            print('  added', f)
        else:
            print('  WARNING: missing', f)
"

# ── 2. Push tutorial files to treads.example.com/treaducation/ ───────────────
echo ""
echo "Syncing to treads.example.com/treaducation/..."
ssh user@your-server "mkdir -p /home/user/docker/treads/www-data/treaducation/"
rsync -av --checksum \
  index.html \
  step1-hello-world.html \
  step2-terrain.html \
  step3-tank.html \
  step4-shoot.html \
  step5-1v1.html \
  README.md \
  treaducation.zip \
  "${REMOTE}"

# ── 3. Push updated landing page (Treaducation button) ───────────────────────
echo ""
echo "Pushing updated landing page..."
scp "${LANDING_LOCAL}" "${LANDING_REMOTE}"

echo ""
echo "Done."
echo "  Tutorial:     https://treads.example.com/treaducation/"
echo "  Download zip: https://treads.example.com/treaducation/treaducation.zip"
echo "  Landing page: https://treads.example.com/"
