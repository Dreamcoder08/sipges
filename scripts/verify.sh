#!/usr/bin/env bash
# Full local gate: lint, format, boundaries, typecheck and every test suite.
# Enables the optional real-PostgreSQL tests when a local server is reachable.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

local_url=postgres://postgres:postgres@127.0.0.1:5432/postgres
if [ -z "${MASCLI_TEST_DATABASE_URL:-}" ] && command -v pg_isready >/dev/null 2>&1; then
  if ! pg_isready -q -h 127.0.0.1; then
    service postgresql start >/dev/null 2>&1 || true
    for _ in 1 2 3 4 5; do pg_isready -q -h 127.0.0.1 && break; sleep 1; done
  fi
  if pg_isready -q -h 127.0.0.1; then export MASCLI_TEST_DATABASE_URL=$local_url; fi
fi

if [ -n "${MASCLI_TEST_DATABASE_URL:-}" ]; then
  echo "verify: PostgreSQL integration tests enabled"
else
  echo "verify: no PostgreSQL server; integration tests run on PGlite only"
fi
pnpm check
