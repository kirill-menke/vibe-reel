# shellcheck shell=bash
# Sourced by the deploy scripts: loads KEY=value lines from the repo's
# gitignored .env.local (see .env.example). A variable already set in the
# environment wins, so `TV=… ./deploy.sh` still overrides the file.
load_env() {
  local f k v
  f="$(dirname "${BASH_SOURCE[0]}")/.env.local"
  [ -f "$f" ] || return 0
  while IFS='=' read -r k v || [ -n "$k" ]; do
    [[ $k =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    [ -n "${!k+x}" ] && continue
    export "$k=$v"
  done <"$f"
}
load_env
