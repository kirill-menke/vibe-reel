#!/usr/bin/env bash
# Install the VibeReel companion service (picture-mode control) on the rooted C4.
#
# The service runs un-jailed (its own run-js-service wrapper) and registers on
# the luna bus as "com.webos.app.multiviewsettings-reel", which the hub matches
# to the real Multi-View Settings app role — that is what grants access to
# com.webos.settingsservice (our own service id is capped at "public" and gets
# "Access denied"). It exposes a loopback HTTP endpoint the web app fetches.
# A Homebrew Channel init.d hook starts it at every boot. No LS2 files and no
# dev/install needed — root file writes + the boot hook are enough.
#
#   TV=<tv-ip> ./deploy-service.sh   (or TV= in .env.local)
#   Exits non-zero if the code didn't land (md5) or the fresh service doesn't
#   answer /health — a stale instance can't pass, since it is killed first.
set -Eeuo pipefail
cd "$(dirname "$0")"
trap 'echo "!! deploy-service FAILED at line $LINENO: $BASH_COMMAND" >&2' ERR

SVCID=com.kirill.reel.service
SVCDIR=/media/developer/apps/usr/palm/services/$SVCID
HOOK=/var/lib/webosbrew/init.d/reel-svc

# shellcheck source=tv-ssh.sh
. ./tv-ssh.sh   # TV, tv_connect → SSH=(…) (key or sshpass; Wake-on-LAN if off)
tv_connect

echo "== push service code to $SVCDIR =="
"${SSH[@]}" "mkdir -p '$SVCDIR' /var/lib/webosbrew/init.d"
( cd service && tar -czf - service.js package.json run-js-service ) \
  | "${SSH[@]}" "cd '$SVCDIR' && tar -xzf - && chmod +x run-js-service && sync"
LOCAL_MD5=$(md5sum service/service.js | cut -d' ' -f1)
TV_MD5=$("${SSH[@]}" "md5sum '$SVCDIR/service.js' | cut -d' ' -f1")
[ "$TV_MD5" = "$LOCAL_MD5" ] || { echo "!! service.js MISMATCH local=$LOCAL_MD5 tv=${TV_MD5:-none}" >&2; exit 1; }

echo "== install boot hook $HOOK =="
"${SSH[@]}" "cat > '$HOOK' && chmod 755 '$HOOK'" < service/tv/reel-svc

echo "== restart service =="
# Kill the running instance precisely (webos-service sets the node process title
# to its bus name), hard, and wait for the port to actually free before starting
# the fresh one — otherwise the boot hook sees the slow-dying old instance still
# answering /health and skips the start, leaving stale code running.
"${SSH[@]}" '
for p in $(pgrep node 2>/dev/null); do
  grep -qa "multiviewsettings-reel" /proc/$p/cmdline 2>/dev/null && kill -9 "$p" 2>/dev/null
done
# The pid file can be stale and its pid reused — only kill if it is still ours.
p=$(cat /tmp/reel-svc.pid 2>/dev/null) &&
  grep -qaE "multiviewsettings-reel|com.kirill.reel.service" /proc/$p/cmdline 2>/dev/null && kill -9 "$p" 2>/dev/null
for i in 1 2 3 4 5; do curl -s --max-time 1 http://127.0.0.1:8791/health >/dev/null 2>&1 || break; sleep 1; done
sh '"$HOOK"'
ok=
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if curl -s --max-time 2 http://127.0.0.1:8791/health; then ok=1; break; fi
done
echo
[ -n "$ok" ] || { echo "!! service did not answer /health — tail /tmp/reel-svc.log:"; tail -n 15 /tmp/reel-svc.log; exit 1; }
echo "-- picture mode read (self-check) --"
curl -s --max-time 6 http://127.0.0.1:8791/picture || echo "(read failed)"
echo'
echo "== done =="
