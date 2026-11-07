#!/usr/bin/env bash
# A throwaway local PostgreSQL for tests and parity: superuser sipges_test, loopback only, one server
# per checkout, so parallel worktrees never share a port. Synthetic data only; never a real database.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/agents/test-pg.sh up|url|down
  up    start the server (idempotent) and print its URL
  url   print the URL of the running server
  down  stop the server and delete its data directory
  TEST_PG_ROOT  directory of the servers (default: ${XDG_STATE_HOME:-$HOME/.local/state}/sipges/test-pg)
  TEST_PG_PORT  first port to try (default 55439)
EOF
}

root="${TEST_PG_ROOT:-${XDG_STATE_HOME:-$HOME/.local/state}/sipges/test-pg}"
name="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")"
dir="$root/$name"
marker="$dir/sipges-test-pg"

url() {
  echo "postgres://sipges_test@127.0.0.1:$(cat "$dir/port")/sipges_test"
}

running() {
  [ -s "$dir/port" ] && pg_ctl -D "$dir/data" status >/dev/null 2>&1
}

free_port() {
  local port="${TEST_PG_PORT:-55439}"
  while (: </dev/tcp/127.0.0.1/"$port") 2>/dev/null; do
    port=$((port + 1))
  done
  echo "$port"
}

case "${1:-}" in
  up)
    if ! running; then
      mkdir -p "$dir"
      touch "$marker"
      [ -d "$dir/data" ] || initdb -D "$dir/data" -U sipges_test --auth=trust -E UTF8 >/dev/null
      free_port >"$dir/port"
      pg_ctl -D "$dir/data" -w -l "$dir/log" \
        -o "-p $(cat "$dir/port") -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" \
        start >/dev/null
      createdb -h 127.0.0.1 -p "$(cat "$dir/port")" -U sipges_test sipges_test 2>/dev/null || true
    fi
    url
    ;;
  url)
    running || {
      echo "no test server for $name; run: scripts/agents/test-pg.sh up" >&2
      exit 1
    }
    url
    ;;
  down)
    running && pg_ctl -D "$dir/data" -w -m fast stop >/dev/null
    # Deletes only what this script created.
    if [ -f "$marker" ]; then rm -rf -- "$dir"; fi
    ;;
  -h | --help) usage ;;
  *)
    usage >&2
    exit 2
    ;;
esac
