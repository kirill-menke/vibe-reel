#!/usr/bin/env bash
# Start (or reuse) the phone dev server for driving the app in desktop Chrome
# — see phone/DEV-CHROME.md.
#
#   phone/dev-chrome.sh          start on 127.0.0.1:8930 if not running; print URLs
#   phone/dev-chrome.sh login    also: sign in to Jellyfin → phone/.devcreds.json
#   phone/dev-chrome.sh stop     stop the server this script started
#   phone/dev-chrome.sh status   is it up?
#
#   PORT=8930   override the port
#   HMR=0       no hot reload: edits by other agents stop reloading (and
#               resetting) the page you drive; reload by hand. Takes effect on
#               a fresh start (stop first if it is already running).
set -euo pipefail

cd "$(dirname "$0")/.."            # repo root (node_modules live here)
PORT="${PORT:-8930}"
URL="http://127.0.0.1:$PORT"
RUN="${XDG_RUNTIME_DIR:-/tmp}/vibereel-phone-dev-$PORT"
PIDF="$RUN.pid"
LOG="$RUN.log"

up() {
  # our server answers /__frame; anything else on the port is somebody else's
  curl -fsS -o /dev/null --max-time 2 "$URL/__frame" 2>/dev/null
}
port_busy() {
  (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null
}

print_urls() {
  echo "VibeReel phone dev server: $URL/"
  echo "  device frame:  $URL/__frame        (options: ?device=375|393|430 &land=1 &safe=0 &chrome=0 &rm=1 &offline=1 &scale=1)"
  echo "  app alone:     $URL/?safe=59,0,34,0"
  if [ -f phone/.devcreds.json ]; then
    echo "  dev login:     phone/.devcreds.json present — the frame signs in by itself"
  else
    echo "  dev login:     none yet — run: phone/dev-chrome.sh login"
  fi
  if [ -f "$RUN.hmr" ]; then echo "  hot reload:    $(cat "$RUN.hmr")"; fi
  echo "  log: $LOG"
}

start() {
  if up; then
    echo "(already running)"
    return 0
  fi
  if port_busy; then
    echo "port $PORT is taken by something that is not the phone dev server; set PORT=…" >&2
    exit 1
  fi
  [ -d node_modules ] || { echo "node_modules missing — run npm install in $(pwd)" >&2; exit 1; }
  # own session/process group: survives the calling terminal, and stop can
  # take down npx + node together
  REEL_DEV_HMR="${HMR:-1}" setsid nohup npx vite --config phone/vite.config.js --host 127.0.0.1 --port "$PORT" --strictPort >"$LOG" 2>&1 </dev/null &
  echo $! >"$PIDF"
  if [ "${HMR:-1}" = 0 ]; then echo "off (HMR=0) — reload the page by hand" >"$RUN.hmr"; else echo "on (other agents' edits reload the page; HMR=0 turns it off)" >"$RUN.hmr"; fi
  for _ in $(seq 1 60); do
    if up; then return 0; fi
    if ! kill -0 "$(cat "$PIDF")" 2>/dev/null; then
      echo "dev server exited — last lines of $LOG:" >&2
      tail -n 20 "$LOG" >&2
      exit 1
    fi
    sleep 0.5
  done
  echo "dev server did not come up within 30 s — see $LOG" >&2
  exit 1
}

case "${1:-start}" in
  start)
    start
    print_urls
    ;;
  login)
    start
    REEL_DEV_URL="$URL" node phone/dev/login.mjs
    print_urls
    ;;
  status)
    if up; then echo "up: $URL/__frame"; else echo "down"; exit 1; fi
    ;;
  stop)
    if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then
      kill -- "-$(cat "$PIDF")" 2>/dev/null || kill "$(cat "$PIDF")" 2>/dev/null || true
      rm -f "$PIDF"
      echo "stopped"
    else
      echo "not started by this script (nothing to stop)"
    fi
    ;;
  *)
    echo "usage: $0 [start|login|status|stop]" >&2
    exit 2
    ;;
esac
