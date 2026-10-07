#!/usr/bin/env bash
# Real-Jellyfin integration run: a throwaway Jellyfin from nixpkgs on 127.0.0.1,
# a tiny ffmpeg-made library, the client contract replayed against it (the real
# TV + phone bundles in headless Chrome, plus direct calls built from src/lib's
# own modules), and that version's OpenAPI diffed against the routes/params the
# client uses. Run it before bumping Jellyfin on the NAS. See README.md here.
#
#   integration/jellyfin/run.sh                         the NAS's pinned nixpkgs (~/.config/nixos)
#   integration/jellyfin/run.sh --version nixos-unstable   a newer nixpkgs (branch, rev, or flake ref)
#   integration/jellyfin/run.sh --version github:nixos/nixpkgs/<rev>
#   integration/jellyfin/run.sh --jellyfin /nix/store/…-jellyfin-12.2   a jellyfin package you built
#   integration/jellyfin/run.sh --serve                 set up, print URL + credentials, wait for Ctrl-C
#   integration/jellyfin/run.sh --no-browser            skip the Chrome scenarios (contract + spec only)
#
# Env: NAS_FLAKE (default ~/.config/nixos) — the flake whose nixpkgs input is "the NAS's pin".
# Exit 0 = every check passed; 1 = a check failed; 2 = the server couldn't be started.
# Everything lives in a mktemp dir that is removed on exit (also on Ctrl-C / failure).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
NAS_FLAKE=${NAS_FLAKE:-$HOME/.config/nixos}
VERSION=nas JF_PKG='' PASS=()
while [ $# -gt 0 ]; do
  case $1 in
    --version|--nixpkgs) VERSION=$2; shift 2 ;;
    --jellyfin) JF_PKG=$2; shift 2 ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) PASS+=("$1"); shift ;;
  esac
done

t0=$(date +%s)
say() { printf '[jellyfin-it %3ss] %s\n' "$(( $(date +%s) - t0 ))" "$*"; }

# ---- 1. the Jellyfin package -------------------------------------------------
if [ -z "$JF_PKG" ]; then
  case $VERSION in
    nas)
      [ -f "$NAS_FLAKE/flake.lock" ] || { echo "no $NAS_FLAKE/flake.lock — set NAS_FLAKE or pass --version <nixpkgs ref>" >&2; exit 2; }
      SRC=(--inputs-from "$NAS_FLAKE" nixpkgs#jellyfin)
      REF="nixpkgs pinned by $NAS_FLAKE ($(jq -r '.nodes[.nodes.root.inputs.nixpkgs].locked.rev // "?"' "$NAS_FLAKE/flake.lock" 2>/dev/null | cut -c1-12))" ;;
    *:*) SRC=("$VERSION#jellyfin"); REF=$VERSION ;;
    *) SRC=("github:nixos/nixpkgs/$VERSION#jellyfin"); REF="github:nixos/nixpkgs/$VERSION" ;;
  esac
  say "building jellyfin from $REF"
  JF_PKG=$(nix build --no-link --print-out-paths "${SRC[@]}" 2>/dev/null | head -1) || { echo "nix build ${SRC[*]} failed" >&2; exit 2; }
fi
JF_BIN=$JF_PKG; [ -d "$JF_PKG" ] && JF_BIN=$JF_PKG/bin/jellyfin
[ -x "$JF_BIN" ] || { echo "not an executable: $JF_BIN" >&2; exit 2; }
# the wrapper passes --ffmpeg=<jellyfin-ffmpeg>; the fixtures are made with that same ffmpeg
FFMPEG=$(grep -o -- '--ffmpeg=[^ "]*' "$JF_BIN" 2>/dev/null | head -1 | cut -d= -f2- || true)
[ -x "${FFMPEG:-}" ] || FFMPEG=$(command -v ffmpeg || true)
[ -x "${FFMPEG:-}" ] || { echo "no ffmpeg (neither the jellyfin wrapper's nor on PATH)" >&2; exit 2; }
say "jellyfin: $JF_PKG"

# ---- 2. a temp dir that always goes, a free port, the server ---------------
TMP=$(mktemp -d "${TMPDIR:-/tmp}/reel-jellyfin-it.XXXXXX")
JF_PID=''
cleanup() {
  local rc=$?
  if [ -n "$JF_PID" ]; then
    kill -TERM -- "-$JF_PID" 2>/dev/null || true
    for _ in $(seq 50); do kill -0 "$JF_PID" 2>/dev/null || break; sleep 0.2; done
    kill -KILL -- "-$JF_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

PORT=$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
mkdir -p "$TMP"/jf/{data,config,cache,log} "$TMP/media"
cat > "$TMP/jf/config/network.xml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<NetworkConfiguration xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <InternalHttpPort>$PORT</InternalHttpPort>
  <PublicHttpPort>$PORT</PublicHttpPort>
  <EnableHttps>false</EnableHttps>
  <AutoDiscovery>false</AutoDiscovery>
  <EnableUPnP>false</EnableUPnP>
  <EnableIPv6>false</EnableIPv6>
  <EnableRemoteAccess>false</EnableRemoteAccess>
  <LocalNetworkAddresses><string>127.0.0.1</string></LocalNetworkAddresses>
  <LocalNetworkSubnets><string>127.0.0.0/8</string></LocalNetworkSubnets>
</NetworkConfiguration>
EOF
MEDIA=$(node "$HERE/fixtures.mjs" "$FFMPEG" | tail -1)
cp -al "$MEDIA/." "$TMP/media/" 2>/dev/null || cp -a "$MEDIA/." "$TMP/media/"

# Offline by construction: .NET's HttpClient honours HTTP(S)_PROXY, so every
# outbound call (plugin repository, metadata providers) fails fast at a dead
# loopback port instead of reaching the internet; loopback itself is exempt.
say "starting jellyfin on 127.0.0.1:$PORT (state in $TMP)"
HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 http_proxy=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 \
NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost DOTNET_CLI_TELEMETRY_OPTOUT=1 \
  setsid "$JF_BIN" --nowebclient --nonetchange \
    -d "$TMP/jf/data" -c "$TMP/jf/config" -C "$TMP/jf/cache" -l "$TMP/jf/log" \
    >"$TMP/jf/log/stdout.log" 2>&1 &
JF_PID=$!
for i in $(seq 240); do
  # 10.11+ answers a "server is starting" HTML page (503/200) until it is really up: wait for the JSON
  if curl -fsS -m 2 "http://127.0.0.1:$PORT/System/Info/Public" 2>/dev/null | jq -e .Version >/dev/null 2>&1; then break; fi
  if ! kill -0 "$JF_PID" 2>/dev/null; then echo "jellyfin exited:" >&2; tail -30 "$TMP/jf/log/stdout.log" >&2; exit 2; fi
  [ "$i" = 240 ] && { echo "jellyfin didn't answer in 120 s" >&2; tail -30 "$TMP/jf/log/stdout.log" >&2; exit 2; }
  sleep 0.5
done
say "jellyfin up: $(curl -fsS "http://127.0.0.1:$PORT/System/Info/Public" | jq -r '"\(.ProductName) \(.Version)"')"

# ---- 3. setup + checks (Node) ----------------------------------------------
set +e
JF_IT_REF=${REF:-$JF_PKG} node "$HERE/run.mjs" --jf "http://127.0.0.1:$PORT" --media "$TMP/media" --tmp "$TMP" --t0 "$t0" "${PASS[@]}"
rc=$?
set -e
if [ "$rc" != 0 ] && [ -f "$TMP/jf/log/stdout.log" ]; then
  mkdir -p "$HERE/.out" && cp "$TMP/jf/log/stdout.log" "$HERE/.out/jellyfin.log" 2>/dev/null || true
  say "server log kept: integration/jellyfin/.out/jellyfin.log"
fi
say "done in $(( $(date +%s) - t0 )) s, exit $rc"
exit "$rc"
