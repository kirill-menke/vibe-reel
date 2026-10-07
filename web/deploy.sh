#!/usr/bin/env bash
# Build the desktop web client and publish it on the NAS.
#
# The NAS serves /var/lib/vibereel-web/current (a symlink) through nginx as
# https://vr.kirill.es — with /jf (Jellyfin) and /ml (reel-api) on the same
# origin, /net.json saying whether a request came in over the LAN or the
# Cloudflare tunnel, and every unknown path falling back to index.html (the
# app routes /movie/<id> etc. itself). Away from home Cloudflare Access sits
# in front; the verify below goes to the NAS directly, so it needs no Access
# session.
#
#   ./web/deploy.sh                 build + publish + verify
#   NO_BUILD=1 ./web/deploy.sh      publish the existing web/dist (DIST=… another dir)
#   NAS=user@host [WEB_ORIGIN=https://…] [WEB_IP=<NAS LAN address>] ./web/deploy.sh
#   (or set them in .env.local; WEB_ORIGIN defaults to https://vr.kirill.es,
#   WEB_IP to the host part of NAS)
#
# Atomic like the phone deploy: the build is rsynced into releases/<stamp>/
# (hard-linking unchanged files from the live release), checked, and only then
# the `current` symlink is swapped with a rename — a dropped ssh or a full disk
# leaves the previous release serving. The last 3 releases are kept.
#
# Exit status: 0 = the origin serves this build (md5 of index.html and every
# script/stylesheet it references, fetched from the NAS with the name pinned
# to WEB_IP); 1 = build/transfer/verify failed — including "the server side
# isn't set up yet" (no releases dir, or nothing answering for WEB_ORIGIN).
set -Eeuo pipefail
cd "$(dirname "$0")/.."
trap 'echo "!! web deploy FAILED at line $LINENO: $BASH_COMMAND" >&2' ERR

# shellcheck source=../env.sh
. ./env.sh
[ -n "${NAS:-}" ] || { echo "!! set NAS=<ssh target> (or put it in .env.local)" >&2; exit 1; }
WEB_ORIGIN=${WEB_ORIGIN:-https://vr.kirill.es}
host=${WEB_ORIGIN#https://}; host=${host%%/*}; hn=${host%%:*}; port=${host##*:}
[ "$port" = "$hn" ] && port=443
WEB_IP=${WEB_IP:-${NAS#*@}}
if ! [[ $WEB_IP =~ ^[0-9.]+$|: ]]; then
  # a host name: curl --resolve wants an address
  WEB_IP=$(getent ahostsv4 "$WEB_IP" | awk 'NR == 1 { print $1 }')
fi
[ -n "$WEB_IP" ] || { echo "!! can't tell the NAS's address — set WEB_IP" >&2; exit 1; }
ROOT=/var/lib/vibereel-web
DIST=${DIST:-web/dist}
KEEP=3
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3 "$NAS")

if [ -z "${NO_BUILD:-}" ]; then
  echo "== vite build (web) =="
  npx vite build --config web/vite.config.js
fi
[ -s "$DIST/index.html" ] || { echo "!! $DIST/index.html missing — nothing to deploy" >&2; exit 1; }

# Ask explicitly: a failed ssh must not read as "directory missing".
"${SSH[@]}" "test -d '$ROOT/releases' && test -w '$ROOT/releases'" || {
  echo "!! $NAS:$ROOT/releases missing or not writable — is the NAS's vibereel-web module deployed?" >&2; exit 1; }

STAMP=$(date +%Y%m%d-%H%M%S)
REL=$ROOT/releases/$STAMP
echo "== rsync $DIST/ → $NAS:$REL =="
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

# Verify through the real name, pinned to the NAS (no Cloudflare, no Access).
fetch() { curl -fsS --max-time 30 --resolve "$hn:$port:$WEB_IP" "$WEB_ORIGIN$1"; }
echo "== verify $WEB_ORIGIN via $WEB_IP =="
if ! fetch /index.html >/dev/null 2>&1; then
  echo "!! $WEB_ORIGIN/index.html doesn't answer on $WEB_IP:$port — is nginx serving $hn yet?" >&2
  trap - ERR
  exit 1
fi

mapfile -t FILES < <(
  echo /index.html
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
# A deep link must get the app (SPA fallback), and /net.json the network
# hint — both only warn: the app works without either, just less well.
dl=$(fetch /movie/deploy-check 2>/dev/null | md5sum | cut -d' ' -f1) || dl=none
[ "$dl" = "$(md5sum < "$DIST/index.html" | cut -d' ' -f1)" ] \
  || echo "   (warning: $WEB_ORIGIN/movie/… doesn't serve index.html — deep links and reloads will 404)" >&2
net=$(fetch /net.json 2>/dev/null || true)
[[ $net == *'"via"'* ]] && echo "   ok  /net.json $net" \
  || echo "   (warning: $WEB_ORIGIN/net.json missing — the quality default stays Original everywhere)" >&2

if [ "$bad" = 0 ]; then
  echo "== deployed OK → $WEB_ORIGIN/ =="
else
  echo "!! deploy MISMATCH — the origin is not serving this build" >&2
  trap - ERR
  exit 1
fi
