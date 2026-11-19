#!/usr/bin/env bash
# A throwaway PgBouncer in TRANSACTION pooling mode in front of this checkout's test-pg.sh server:
# what Cloudflare Hyperdrive and PlanetScale's pooler do to the APIs' connections. Each transaction
# may run on a different server connection, and a few server connections serve every client, so
# session state (SET, session advisory locks, named prepared statements) would leak or vanish.
# Loopback only, trust authentication, synthetic data only; never in front of a real database.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/agents/test-pgbouncer.sh up|url|addr|down
  up    start PgBouncer in front of the running test-pg.sh server (idempotent) and print its URL
  url   print the URL of the running pooler (the test server's admin login, through PgBouncer)
  addr  print host:port of the running pooler
  down  stop the pooler and delete its directory
  PGBOUNCER                  binary (default: pgbouncer on PATH)
  TEST_PGBOUNCER_POOL_SIZE   server connections per database and user (default 3: forces sharing)
  TEST_PGBOUNCER_PREPARED    max_prepared_statements (default 0: no protocol-level named
                             statements across transactions, the strictest pooler)
  TEST_PG_ROOT               same as test-pg.sh; the pooler lives next to its server
EOF
}

here="$(cd "$(dirname "$0")" && pwd)"
root="${TEST_PG_ROOT:-${XDG_STATE_HOME:-$HOME/.local/state}/sipges/test-pg}"
name="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")"
dir="$root/$name-pgbouncer"
marker="$dir/sipges-test-pgbouncer"
bin="${PGBOUNCER:-pgbouncer}"

addr() {
  echo "127.0.0.1:$(cat "$dir/port")"
}

running() {
  [ -s "$dir/pid" ] && kill -0 "$(cat "$dir/pid")" 2>/dev/null
}

free_port() {
  local port=56432
  while (: </dev/tcp/127.0.0.1/"$port") 2>/dev/null; do
    port=$((port + 1))
  done
  echo "$port"
}

case "${1:-}" in
  up)
    if ! running; then
      server="$("$here/test-pg.sh" url)" # fails when the test server is not running
      server_port="${server##*:}"
      server_port="${server_port%%/*}"
      command -v "$bin" >/dev/null || {
        echo "pgbouncer not found; install it or set PGBOUNCER" >&2
        exit 1
      }
      mkdir -p "$dir"
      touch "$marker"
      free_port >"$dir/port"
      # The admin login needs no password (test-pg.sh trusts loopback); every other login is
      # looked up with auth_query through it, and the server trusts the pooler's connection.
      printf '"sipges_test" ""\n' >"$dir/users.txt"
      cat >"$dir/pgbouncer.ini" <<EOF
[databases]
* = host=127.0.0.1 port=$server_port

[pgbouncer]
listen_addr = 127.0.0.1
listen_port = $(cat "$dir/port")
unix_socket_dir =
auth_type = trust
auth_file = $dir/users.txt
auth_user = sipges_test
pool_mode = transaction
default_pool_size = ${TEST_PGBOUNCER_POOL_SIZE:-3}
max_client_conn = 500
max_prepared_statements = ${TEST_PGBOUNCER_PREPARED:-0}
ignore_startup_parameters = extra_float_digits,options
server_reset_query =
logfile = $dir/log
pidfile = $dir/pid
EOF
      "$bin" -d "$dir/pgbouncer.ini" >/dev/null
      for _ in $(seq 50); do
        (: </dev/tcp/127.0.0.1/"$(cat "$dir/port")") 2>/dev/null && break
        sleep 0.1
      done
    fi
    echo "postgres://sipges_test@$(addr)/sipges_test"
    ;;
  url)
    running || {
      echo "no pooler for $name; run: scripts/agents/test-pgbouncer.sh up" >&2
      exit 1
    }
    echo "postgres://sipges_test@$(addr)/sipges_test"
    ;;
  addr)
    running || {
      echo "no pooler for $name; run: scripts/agents/test-pgbouncer.sh up" >&2
      exit 1
    }
    addr
    ;;
  down)
    if running; then
      kill "$(cat "$dir/pid")"
      for _ in $(seq 50); do running || break; sleep 0.1; done
    fi
    # Deletes only what this script created.
    if [ -f "$marker" ]; then rm -rf -- "$dir"; fi
    ;;
  -h | --help) usage ;;
  *)
    usage >&2
    exit 2
    ;;
esac
