#!/usr/bin/env bash
# Measures the spike from this machine through the Worker. Prints one JSON object per line.
#   SPIKE_URL=https://sipges-go-spike.<subdomain>.workers.dev SPIKE_TOKEN=... ./measure.sh warm|cold [samples]
# warm: N× /worker (edge-only baseline) and /health, plus 3× /db-ping?n=100 per target.
# cold: waits for the container to sleep (sleepAfter 2m + margin) before each /health.
set -euo pipefail
: "${SPIKE_URL:?set SPIKE_URL}"
mode=${1:-warm}; samples=${2:-50}
# curl write-out; times are in seconds.
fmt='{"path":"@PATH@","code":%{http_code},"totalS":%{time_total},"connectS":%{time_connect},"ttfbS":%{time_starttransfer},"containerFetchMs":"%header{x-container-fetch-ms}","ray":"%header{cf-ray}"}\n'
probe() { curl -s -o /dev/null -w "${fmt//@PATH@/$1}" "$SPIKE_URL$1"; }

case "$mode" in
  warm)
    probe /health >/dev/null # make sure the container is up
    for _ in $(seq "$samples"); do probe /worker; done
    for _ in $(seq "$samples"); do probe /health; done
    for target in direct pooled; do
      for _ in 1 2 3; do
        curl -s -H "authorization: Bearer ${SPIKE_TOKEN:?set SPIKE_TOKEN}" "$SPIKE_URL/db-ping?n=100&target=$target"
      done
    done
    ;;
  cold)
    for _ in $(seq "$samples"); do
      sleep 170
      probe /health
      curl -s "$SPIKE_URL/health"
    done
    ;;
  *) echo "usage: $0 warm|cold [samples]" >&2; exit 2 ;;
esac
