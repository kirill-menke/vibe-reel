#!/usr/bin/env bash
# Regenerates the PWA icons and launch screens (committed; rerun only to change them).
#
#   ./phone/make-icons.sh           both
#   ./phone/make-icons.sh icons     phone/public/icons only
#   ./phone/make-icons.sh splash    phone/public/splash + the <link> block in phone/index.html
#
# Icons: the same gold VibeReel glyph build-ipk.sh draws for the TV launcher, on a
# full-bleed near-black square: iOS and Android apply their own corner mask, so no
# rounding here. The maskable variants keep the glyph inside the 80 % safe circle.
#
# Launch screens (PWA-01): iOS ignores the manifest's background_color and shows an
# `apple-touch-startup-image` only when its media query matches the device exactly
# (else a white screen). Plain #0a0a0c, no logo — HIG: a launch screen looks like the
# app's empty first frame, and the first frame is the dark shell. One portrait + one
# landscape image per device class below; the <link>s in index.html are rewritten
# from the same table (between the splash:begin/end markers), so they can't drift.
# The images are not precached by sw.js (phone/vite.config.js `sw-precache`).
set -euo pipefail
cd "$(dirname "$0")"
command -v magick >/dev/null || { echo "!! ImageMagick 7 (magick) not found — run inside 'nix develop'" >&2; exit 1; }
what=${1:-all}

BG='#0a0a0c'

icon() { # icon <size> <glyph width as a fraction of the size> <out>
  local s=$1 sc c
  sc=$(awk "BEGIN{print $1*$2/90}")
  c=$(awk "BEGIN{print $1/2}")
  magick -size "${s}x${s}" xc:"$BG" \
    -fill '#e6b450' -draw "translate $c,$c scale $sc,$sc translate -51,-50 roundrectangle 6,31 17,69 5.5,5.5 roundrectangle 24,19 35,81 5.5,5.5 roundrectangle 42,27 53,73 5.5,5.5 polygon 62,25 62,75 96,50" \
    "public/icons/$3"
}

# device-width device-height DPR   models (CSS px, portrait; iOS 17+ iPhones)
# Add a row for every new screen size (check Apple's tech specs each September).
SPLASH_TABLE='
440 956 3  16 Pro Max, 17 Pro Max
402 874 3  16 Pro, 17, 17 Pro
420 912 3  iPhone Air
430 932 3  14 Pro Max, 15 Plus / Pro Max, 16 Plus
393 852 3  14 Pro, 15, 15 Pro, 16
428 926 3  12 / 13 Pro Max, 14 Plus
390 844 3  12, 13, 14, 16e
375 812 3  X, XS, 11 Pro, 12 / 13 mini
414 896 3  XS Max, 11 Pro Max
414 896 2  XR, 11
375 667 2  SE 2nd / 3rd gen, 8
'

splash() {
  rm -rf public/splash
  mkdir -p public/splash
  local links='' w h r models pw ph q
  while read -r w h r models; do
    [ -n "$w" ] || continue
    pw=$((w * r)); ph=$((h * r))
    magick -size "${pw}x${ph}" xc:"$BG" -strip "public/splash/${pw}x${ph}.png"
    magick -size "${ph}x${pw}" xc:"$BG" -strip "public/splash/${ph}x${pw}.png"
    q="screen and (device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${r})"
    links+="<!-- ${models} -->"$'\n'
    links+="<link rel=\"apple-touch-startup-image\" href=\"/splash/${pw}x${ph}.png\" media=\"${q} and (orientation: portrait)\">"$'\n'
    links+="<link rel=\"apple-touch-startup-image\" href=\"/splash/${ph}x${pw}.png\" media=\"${q} and (orientation: landscape)\">"$'\n'
  done <<<"$SPLASH_TABLE"
  grep -q '<!-- splash:begin' index.html && grep -q '<!-- splash:end' index.html ||
    { echo "!! index.html has no splash:begin/end markers" >&2; exit 1; }
  LINKS="$links" awk '
    /<!-- splash:begin/ { print; printf "%s", ENVIRON["LINKS"]; skip = 1; next }
    /<!-- splash:end/   { skip = 0 }
    !skip' index.html >index.html.tmp
  mv index.html.tmp index.html
  echo "splash: $(find public/splash -name '*.png' | wc -l) images, $(grep -c apple-touch-startup-image index.html) links"
}

case $what in
  icons | all)
    icon 180 0.56 apple-touch-icon.png
    icon 192 0.56 icon-192.png
    icon 512 0.56 icon-512.png
    icon 192 0.42 icon-maskable-192.png
    icon 512 0.42 icon-maskable-512.png
    icon 64 0.66 favicon-64.png
    ;;&
  splash | all) splash ;;
  icons) ;;
  *) echo "usage: $0 [icons|splash|all]" >&2; exit 2 ;;
esac
