#!/usr/bin/env bash
# Installs the Playwright browser for CI (.github/workflows/ci.yml). The install has hung for the
# whole job timeout before any test ran, so each attempt is bounded. GitHub-hosted runners also
# install system packages. When an attempt times out, `timeout` ends pnpm but apt-get lives on with
# the dpkg lock, so every retry would fail at once: stop it and repair dpkg between attempts.
# Self-hosted images bake those packages, so they skip apt and all of this.
set -uo pipefail

browser="$1"
seconds=300
deps=()
hosted=false
if [ "${SIPGES_CI_RUNNER:-}" = github-hosted ]; then
  seconds=480
  deps=(--with-deps)
  hosted=true
fi

for attempt in 1 2 3; do
  timeout "$seconds" pnpm --filter @sipges/e2e exec playwright install "${deps[@]}" "$browser" && exit 0
  echo "playwright install attempt $attempt failed" >&2
  if [ "$hosted" = true ] && [ "$attempt" -lt 3 ]; then
    echo "A timed-out apt-get keeps the dpkg lock: stopping it and repairing dpkg" >&2
    sudo pkill -x apt-get
    sudo timeout 120 dpkg --configure -a || echo "dpkg repair failed; retrying anyway" >&2
  fi
done
exit 1
