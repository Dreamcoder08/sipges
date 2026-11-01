#!/usr/bin/env bash
# Explicit test configuration only: never start services or infer credentials.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
if [ -n "${SIPGES_TEST_DATABASE_URL:-}" ]; then
  echo "verify: PostgreSQL integration tests enabled (explicit synthetic connection)"
else
  echo "verify: PGlite enabled; optional PostgreSQL tests skipped (omitidas)"
fi
pnpm check
