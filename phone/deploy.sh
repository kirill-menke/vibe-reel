#!/usr/bin/env bash
# Build the iPhone PWA and publish it on the NAS.
#
# The NAS serves /var/lib/vibereel-phone/current (a symlink) through nginx,
# behind `tailscale serve` on https://nas.<tailnet>.ts.net:9443/ — with /jf
# (Jellyfin) and /ml (reel-api) on the same origin — and optionally on the LAN
# over plain http (no service worker there). See docs/ios/ARCHITECTURE.md.
#
#   ./phone/deploy.sh               build + publish + verify
#   NO_BUILD=1 ./phone/deploy.sh    publish the existing phone/dist (DIST=… another dir)
#   NAS=user@host ORIGIN=https://…:9443 [LAN_ORIGIN=http://…] ./phone/deploy.sh
#   (or set NAS / ORIGIN / LAN_ORIGIN in .env.local)
#
# Atomic like the TV deploy: the build is rsynced into releases/<stamp>/
# (hard-linking unchanged files from the live release), checked, and only then
# the `current` symlink is swapped with a rename — a dropped ssh or a full disk
# leaves the previous release serving. The last 3 releases are kept.
#
# Exit status: 0 = the new build is what the HTTPS origin serves (md5 of
# index.html, sw.js and every script/stylesheet index.html references);
# 1 = build/transfer/verify failed.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
trap 'echo "!! phone deploy FAILED at line $LINENO: $BASH_COMMAND" >&2' ERR

# shellcheck source=../env.sh
. ./env.sh
[ -n "${NAS:-}" ] && [ -n "${ORIGIN:-}" ] || {
  echo "!! set NAS=<ssh target> and ORIGIN=<https origin> (or put them in .env.local)" >&2; exit 1; }
LAN_ORIGIN=${LAN_ORIGIN:-}
ROOT=/var/lib/vibereel-phone
DIST=${DIST:-phone/dist}
KEEP=3
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3 "$NAS")

if [ -z "${NO_BUILD:-}" ]; then
  echo "== vite build (phone) =="
  npx vite build --config phone/vite.config.js
fi
[ -s "$DIST/index.html" ] || { echo "!! $DIST/index.html missing — nothing to deploy" >&2; exit 1; }

# Ask explicitly: a failed ssh must not read as "directory missing".
"${SSH[@]}" "test -d '$ROOT/releases' && test -w '$ROOT/releases'" || {
  echo "!! $NAS:$ROOT/releases missing or not writable — is vibereel-phone.nix deployed?" >&2; exit 1; }

STAMP=$(date +%Y%m%d-%H%M%S)
REL=$ROOT/releases/$STAMP
echo "== rsync $DIST/ → $NAS:$REL =="
# --link-dest: unchanged files become hard links to the live release (cheap).
rsync -a --delete --link-dest="$ROOT/current/" \
  -e "ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3" \
  "$DIST/" "$NAS:$REL/"

# Swap: check the staged copy is whole, then rename a fresh symlink over
# `current` (rename(2) is atomic; nginx never sees a missing root).
LOCAL_SUM=$(cd "$DIST" && find . -type f -print0 | sort -z | xargs -0 md5sum | md5sum | cut -d' ' -f1)
"${SSH[@]}" "set -e; cd '$REL'
  sum=\$(find . -type f -print0 | sort -z | xargs -0 md5sum | md5sum | cut -d' ' -f1)
  [ \"\$sum\" = '$LOCAL_SUM' ] || { echo 'staged release incomplete' >&2; rm -rf '$REL'; exit 1; }
  ln -sfn 'releases/$STAMP' '$ROOT/.current.new'
  mv -Tf '$ROOT/.current.new' '$ROOT/current'
  cd '$ROOT/releases' && ls -1d */ | sed 's#/\$##' | sort | head -n -$KEEP | xargs -r rm -rf"
echo "== live: releases/$STAMP =="

# Verify through the real origin. This machine may not be on the tailnet; then
# fetch from the NAS itself, pinning the name to its own tailnet address (the
# NAS doesn't resolve MagicDNS, see tailscale.nix --accept-dns=false).
host=${ORIGIN#https://}; host=${host%%/*}; hn=${host%%:*}; port=${host##*:}
[ "$port" = "$hn" ] && port=443
if curl -fsS -o /dev/null --max-time 5 "$ORIGIN/index.html" 2>/dev/null; then
  fetch() { curl -fsS --max-time 30 "$ORIGIN$1"; }
  VIA=local
else
  TSIP=$("${SSH[@]}" "tailscale ip -4" | head -1)
  fetch() { "${SSH[@]}" "curl -fsS --max-time 30 --resolve '$hn:$port:$TSIP' '$ORIGIN$1'"; }
  VIA="the NAS ($TSIP)"
fi
echo "== verify $ORIGIN via $VIA =="

# index.html, sw.js, and every local script/stylesheet the page references.
mapfile -t FILES < <(
  echo /index.html
  [ -f "$DIST/sw.js" ] && echo /sw.js
  grep -oE '(src|href)="[^"]+\.(js|css)"' "$DIST/index.html" | sed -E 's/^[a-z]+="//; s/"$//' \
    | grep -vE '^(https?:)?//' | sed -E 's#^\./#/#; s#^([^/])#/\1#' | sort -u
)
bad=0
for f in "${FILES[@]}"; do
  l=$(md5sum < "$DIST$f" | cut -d' ' -f1)
  r=$(fetch "$f" 2>/dev/null | md5sum | cut -d' ' -f1) || r=none
  if [ "$l" = "$r" ]; then echo "   ok  $f $l"
  else echo "!! MISMATCH $f local=$l served=$r" >&2; bad=1; fi
done
# The LAN fallback serves the same directory; a failure there is only a warning.
if [ -n "$LAN_ORIGIN" ]; then
  l=$(md5sum < "$DIST/index.html" | cut -d' ' -f1)
  r=$(curl -fsS --max-time 10 "$LAN_ORIGIN/index.html" 2>/dev/null | md5sum | cut -d' ' -f1) || true
  [ "$l" = "$r" ] || echo "   (warning: LAN fallback $LAN_ORIGIN/ doesn't serve this index.html)" >&2
fi

if [ "$bad" = 0 ]; then
  echo "== deployed OK → $ORIGIN/${LAN_ORIGIN:+ (LAN: $LAN_ORIGIN/)} =="
else
  echo "!! deploy MISMATCH — the origin is not serving this build" >&2
  trap - ERR
  exit 1
fi
