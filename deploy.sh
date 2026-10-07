#!/usr/bin/env bash
# Build the IPK and install it on the rooted C4.
#
# The scripted path (com.webos.appInstallService/dev/install) only works while
# an LG *Developer Mode* session is live; once it lapses the endpoint silently
# returns nothing and the old files are left in place (a stale, "successful"
# deploy).  This TV is rooted, so the reliable path is to unpack the IPK payload
# straight into the app directory over ssh — no luna, no dev-mode dependency.
# dev/install is kept only as the way to register a brand-new app the first time.
#
#   TV=<tv-ip> ./deploy.sh      (or TV= in .env.local; NO_WOL=1: don't wake the TV; NO_RELAUNCH=1)
#
# Exit status: 0 = the new build is on the TV and in the foreground; anything
# else is loud. 1 = build/transfer/verify failed (the TV keeps its previous
# build intact — the payload is staged beside the app dir and swapped in only
# once fully unpacked), 3 = files landed but the relaunch didn't take, so the
# TV is still running the old build.
set -Eeuo pipefail
cd "$(dirname "$0")"
trap 'echo "!! deploy FAILED at line $LINENO: $BASH_COMMAND" >&2' ERR

APPID=com.kirill.reel
APPDIR=/media/developer/apps/usr/palm/applications/$APPID
# shellcheck source=tv-ssh.sh
. ./tv-ssh.sh   # TV, SSH_OPTS, tv_prewake, tv_connect (Wake-on-LAN if the TV is off)

tv_prewake      # a sleeping TV boots while we build
./build-ipk.sh
tv_connect
IPK=$(ls -t out/${APPID}_*.ipk | head -1)
IPK_ABS=$PWD/$IPK
LOCAL_MD5=$(md5sum dist/app.js | cut -d' ' -f1)

# Ask explicitly: a failed ssh must not read as "not installed yet".
HAVE=$("${SSH[@]}" "[ -d '$APPDIR' ] && echo yes || echo no")
if [ "$HAVE" = yes ]; then
  # App already registered — unpack the payload in place (rooted bypass).
  echo "== direct-unpack $IPK into $APPDIR =="
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  ( cd "$tmp" && ar x "$IPK_ABS" && mkdir d && tar -xzf data.tar.gz -C d )
  # Stage next to the live dir (same filesystem), then swap: a dropped ssh or a
  # full disk fails in the staging step and leaves the installed build whole,
  # instead of a half-overwritten app dir. The swap also drops stale files.
  ( cd "$tmp/d/usr/palm/applications/$APPID" && tar -czf - . ) \
    | "${SSH[@]}" "set -e; N='$APPDIR.new' O='$APPDIR.old'
        rm -rf \"\$N\" \"\$O\"; mkdir \"\$N\"
        tar -xzf - -C \"\$N\"
        [ -s \"\$N/app.js\" ] && [ -s \"\$N/appinfo.json\" ] || { echo 'payload incomplete' >&2; exit 1; }
        sync
        mv '$APPDIR' \"\$O\"
        mv \"\$N\" '$APPDIR' || { mv \"\$O\" '$APPDIR'; exit 1; }
        rm -rf \"\$O\"; sync"
else
  # First-time install needs the (dev-mode) installer to register the app.
  echo "== first install via dev/install (needs Developer Mode live) =="
  "${SSH[@]}" "cat > /tmp/reel.ipk" < "$IPK"
  timeout 90 "${SSH[@]}" "luna-send -i 'luna://com.webos.appInstallService/dev/install' \
    '{\"id\":\"$APPID\",\"ipkUrl\":\"/tmp/reel.ipk\",\"subscribe\":true}'" >/dev/null 2>&1 || true
fi

# Confirm the files that actually landed match what we built (check app.js AND
# style.css — a CSS-only change wouldn't be caught by an app.js check alone).
# vite.config.js pins these two output names precisely so this check keeps
# working against a bundled build.
CSS_LOCAL=$(md5sum dist/style.css | cut -d' ' -f1)
TV_MD5=$("${SSH[@]}" "md5sum '$APPDIR/app.js' 2>/dev/null | cut -d' ' -f1" 2>/dev/null || true)
CSS_TV=$("${SSH[@]}" "md5sum '$APPDIR/style.css' 2>/dev/null | cut -d' ' -f1" 2>/dev/null || true)
if [ "$TV_MD5" = "$LOCAL_MD5" ] && [ "$CSS_TV" = "$CSS_LOCAL" ]; then
  echo "== deployed OK (app.js $TV_MD5) =="
else
  echo "!! deploy MISMATCH: app.js local=$LOCAL_MD5 tv=${TV_MD5:-none}; style.css local=$CSS_LOCAL tv=${CSS_TV:-none}" >&2
  exit 1
fi

# Relaunch so the new build is what runs: a running (or parked) webview keeps
# the old one. Close first -- launching an app that is already up only brings
# it forward. NO_RELAUNCH=1 skips this.
#
# Every luna-send gets </dev/null: it quits without an answer (exit 0, no
# output, nothing done) the moment its stdin hangs up, and a non-interactive
# ssh session hands it a pipe that does exactly that. /dev/null reads as EOF
# but never hangs up; a TTY (ssh -tt) also works but mangles the output.
if [ -z "${NO_RELAUNCH:-}" ]; then
  LUNA=luna://com.webos.service.applicationmanager
  luna() { "${SSH[@]}" "luna-send -n 1 $LUNA/$1 '$2' </dev/null" 2>/dev/null || true; }
  fg_app() { luna getForegroundAppInfo '{}' | sed -n 's/.*"appId":"\([^"]*\)".*/\1/p'; }
  luna closeByAppId "{\"id\":\"$APPID\"}" >/dev/null
  sleep 1
  # Poll rather than trust one fixed sleep; a TV that just woke from WoL can
  # take several seconds to bring an app up. One relaunch retry, then fail.
  FG='' OUT=''
  for attempt in 1 2; do
    OUT=$(luna launch "{\"id\":\"$APPID\"}")
    for _ in 1 2 3 4 5 6 7 8; do
      sleep 1
      FG=$(fg_app)
      if [ "$FG" = "$APPID" ]; then break 2; fi
    done
    echo "== relaunch attempt $attempt: foreground is ${FG:-unknown}, retrying ==" >&2
  done
  if [ "$FG" = "$APPID" ]; then
    echo "== relaunched: $APPID is in the foreground =="
  else
    echo "!! relaunch did not take (foreground: ${FG:-unknown}; launch said: ${OUT:-nothing})." >&2
    echo "!! The new files ARE on the TV, but the old build may still be running — relaunch 'VibeReel'." >&2
    trap - ERR
    exit 3
  fi
fi
