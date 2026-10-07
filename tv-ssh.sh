# shellcheck shell=bash
# Sourced by deploy.sh and deploy-service.sh — reach the rooted C4 as root over
# ssh, waking it with Wake-on-LAN first when it doesn't answer.
#
#   TV=…        address (required; set it here or in .env.local)
#   TV_PASS=…   root password if no ssh key is installed (default: webosbrew's "alpine")
#   TV_MAC=…    Wake-on-LAN target (needs "Turn on via Wi-Fi"; unset = no WoL)
#   NO_WOL=1    fail instead of waking the TV
#   WOL_WAIT=…  seconds to wait for ssh after waking (default 90)
#
# While off, the TV still answers ARP but not ssh, so a unicast magic packet
# reaches it; the broadcast copies are belt and braces.

# shellcheck source=env.sh
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
[ -n "${TV:-}" ] || { echo "!! set TV=<address of the TV> (or put it in .env.local)" >&2; exit 1; }
TV_PASS=${TV_PASS:-alpine}
TV_MAC=${TV_MAC:-}
# ServerAlive*: an ssh that loses the TV mid-transfer (Wi-Fi drop, TV powering
# off) errors out after ~15 s instead of hanging on a dead TCP connection.
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10
          -o ServerAliveInterval=5 -o ServerAliveCountMax=3)

tv_port_open() { timeout 3 bash -c "exec 3<>/dev/tcp/$TV/22" 2>/dev/null; }

tv_wake() {
  [ -n "$TV_MAC" ] || return 0
  local hex=${TV_MAC//:/} m='' p='\xff\xff\xff\xff\xff\xff' i port
  for ((i = 0; i < 12; i += 2)); do m+="\\x${hex:i:2}"; done
  for ((i = 0; i < 16; i++)); do p+=$m; done
  for port in 9 7; do
    # shellcheck disable=SC2059  # $p is the packet, built from \x escapes
    printf "$p" 2>/dev/null >"/dev/udp/$TV/$port" || true
  done
  if command -v python3 >/dev/null; then
    python3 - "$TV_MAC" "${TV%.*}.255" <<'PY' 2>/dev/null || true
import socket, sys
pkt = b'\xff' * 6 + bytes.fromhex(sys.argv[1].replace(':', '')) * 16
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
for host in (sys.argv[2], '255.255.255.255'):
    for port in (9, 7):
        try: s.sendto(pkt, (host, port))
        except OSError: pass
PY
  fi
}

# Fire-and-forget early wake, so the TV boots while we build.
tv_prewake() {
  [ -z "${NO_WOL:-}" ] && [ -n "$TV_MAC" ] && ! tv_port_open && { echo "== $TV not answering: Wake-on-LAN → $TV_MAC =="; tv_wake; }
  return 0
}

# Sets SSH=(…) to a working root ssh command, or returns 1 loudly.
tv_connect() {
  if ! tv_port_open; then
    if [ -n "${NO_WOL:-}" ] || [ -z "$TV_MAC" ]; then
      echo "!! $TV:22 not answering (TV off? no Wake-on-LAN: NO_WOL set or TV_MAC unset)" >&2; return 1
    fi
    echo "== waiting for $TV (Wake-on-LAN → $TV_MAC) =="
    local start=$SECONDS last=-10
    until tv_port_open; do
      if [ $((SECONDS - start)) -ge "${WOL_WAIT:-90}" ]; then
        echo "!! $TV still unreachable after $((SECONDS - start))s of Wake-on-LAN" >&2; return 1
      fi
      if [ $((SECONDS - last)) -ge 10 ]; then tv_wake; last=$SECONDS; fi
      sleep 2
    done
    echo "== $TV up after $((SECONDS - start))s =="
    sleep 3 # port 22 opens a moment before sshd accepts logins
  fi
  if ssh -o BatchMode=yes "${SSH_OPTS[@]}" "root@$TV" true 2>/dev/null; then
    SSH=(ssh "${SSH_OPTS[@]}" "root@$TV")
  elif command -v sshpass >/dev/null; then
    SSH=(env SSHPASS="$TV_PASS" sshpass -e ssh "${SSH_OPTS[@]}" "root@$TV")
    "${SSH[@]}" true || { echo "!! ssh to root@$TV failed (key and password)" >&2; return 1; }
  else
    echo "!! no ssh key access to root@$TV and sshpass missing (nix develop)" >&2; return 1
  fi
}
