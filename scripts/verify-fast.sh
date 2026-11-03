#!/usr/bin/env bash
# Fast local gate: static checks in parallel and tests of the packages a change affects.
# CI still runs the full suite (pnpm verify) on every PR; merge only with all its checks green.
# Explicit test configuration only: never start services or infer credentials.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
base="${SIPGES_VERIFY_BASE:-origin/main}"
affected="...[$base]"
status=0

# Lint, layer boundaries and typecheck are light: run them at the same time.
pnpm lint &
lint=$!
{ pnpm boundaries && pnpm odd:check; } &
boundaries=$!
pnpm --filter "$affected" run typecheck &
typecheck=$!
for job in "$lint" "$boundaries" "$typecheck"; do
  wait "$job" || status=1
done

# Tests of the changed packages and their dependents, one package at a time: the API suite
# runs PGlite and needs the memory to itself.
pnpm --filter "$affected" --workspace-concurrency=1 run test || status=1

# Repository tooling (scripts, agent skills) has its own tests.
if git diff --name-only "$base" -- scripts .agents .claude | grep -q .; then
  pnpm test:tooling || status=1
fi

exit "$status"
