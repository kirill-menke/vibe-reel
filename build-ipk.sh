#!/usr/bin/env bash
# Build the Svelte app with Vite and package the result as an IPK.
#
# Layout: src/ is the Svelte source, public/ holds files shipped verbatim
# (appinfo.json, the 60p refresh clip, the generated launcher icons). Vite emits
# dist/, and ares-package packages dist/ — so dist/ is what lands on the TV.
set -euo pipefail
cd "$(dirname "$0")"

# Launcher icons: the VibeReel 2a glyph (waveform → play) in gold on a dark
# #131109 rounded tile with a faint gold border. Regenerated each build, into
# public/ so the Vite build copies them through to dist/.
command -v magick >/dev/null || { echo "!! ImageMagick 7 (magick) not found — run inside 'nix develop'" >&2; exit 1; }
glyph() { # glyph() <size> <radius> <scale> <center> <out>
  magick -size "$1x$1" xc:none \
    -fill '#131109' -draw "roundrectangle 0,0 $(($1-1)),$(($1-1)) $2,$2" \
    -fill '#e6b450' -draw "translate $4,$4 scale $3,$3 translate -51,-50 roundrectangle 6,31 17,69 5.5,5.5 roundrectangle 24,19 35,81 5.5,5.5 roundrectangle 42,27 53,73 5.5,5.5 polygon 62,25 62,75 96,50" \
    -fill none -stroke 'rgba(230,180,80,0.4)' -strokewidth 1 -draw "roundrectangle 0.5,0.5 $(($1-1)),$(($1-1)) $2,$2" \
    "$5"
}
glyph 80 19 0.489 40 public/icon.png
glyph 130 31 0.794 65 public/largeIcon.png

[ -d node_modules ] || npm install --no-audit --no-fund

npx vite build

# A failed build must not leave an older IPK for deploy.sh to pick up: drop
# this app's IPKs first and make sure the build emitted the two pinned bundles.
mkdir -p out
rm -f out/com.kirill.reel_*.ipk
[ -s dist/app.js ] && [ -s dist/style.css ] || { echo "!! vite build produced no dist/app.js or dist/style.css" >&2; exit 1; }
npx ares-package dist -o out -n
ls -la out/*.ipk
