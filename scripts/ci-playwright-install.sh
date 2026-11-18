#!/usr/bin/env bash
# Installs the Playwright browser for CI (.github/workflows/ci.yml) in two phases, so a failure
# names its cause:
#   1. GitHub-hosted runners only: the system packages the browser needs (`playwright install-deps`,
#      apt-get). WebKit needs ~185 packages, and the Ubuntu mirror has served them at ~30 kB/s until
#      every attempt timed out (runs 44245469534 and 44381056971). SIPGES_APT_ARCHIVES is a folder
#      actions/cache keeps: its .deb files are copied into apt's archive before the install, so apt
#      skips downloading them, and the downloaded ones are copied back for the next run.
#   2. The browser download itself (`playwright install`); a restored ~/.cache/ms-playwright makes
#      it a no-op.
# Each attempt is bounded and retried with a growing pause. When an apt attempt times out,
# `timeout` ends pnpm but apt-get lives on with the dpkg lock, so it is stopped and dpkg repaired
# before the next one. Self-hosted images bake the system packages and keep the browsers in their
# volume, so they skip phase 1, apt and sudo.
set -uo pipefail
shopt -s nullglob

browser="$1"
hosted=false
[ "${SIPGES_CI_RUNNER:-}" = github-hosted ] && hosted=true
apt_cache="${SIPGES_APT_ARCHIVES:-}"
# The workflow passes the ~/ path actions/cache uses; bash does not expand ~ inside a value.
case "$apt_cache" in \~/*) apt_cache="$HOME/${apt_cache#\~/}" ;; esac
system_archives="${SIPGES_APT_SYSTEM_ARCHIVES:-/var/cache/apt/archives}"
pauses=(15 45)

repair_dpkg() {
  echo "A timed-out apt-get keeps the dpkg lock: stopping it and repairing dpkg" >&2
  sudo pkill -x apt-get
  sudo timeout 120 dpkg --configure -a || echo "dpkg repair failed; retrying anyway" >&2
}

# retry <what> <seconds per attempt> <repair dpkg: true|false> <command...>
retry() {
  local what="$1" seconds="$2" repair="$3" attempt
  shift 3
  for attempt in 1 2 3; do
    timeout "$seconds" "$@" && return 0
    echo "$what: attempt $attempt/3 failed" >&2
    [ "$attempt" -eq 3 ] && break
    [ "$repair" = true ] && repair_dpkg
    echo "Retrying in ${pauses[attempt - 1]} s" >&2
    sleep "${pauses[attempt - 1]}"
  done
  return 1
}

if [ "$hosted" = true ]; then
  if [ -n "$apt_cache" ]; then
    cached=("$apt_cache"/*.deb)
    echo "Reusing ${#cached[@]} cached apt packages" >&2
    [ "${#cached[@]}" -gt 0 ] && sudo cp -- "${cached[@]}" "$system_archives/"
  fi
  if ! retry "System packages for $browser (apt-get, Ubuntu package mirror)" 480 true \
    pnpm --filter @sipges/e2e exec playwright install-deps "$browser"; then
    echo "::error title=Playwright system packages::apt-get could not install the system packages $browser needs from the Ubuntu package mirror in 3 attempts. The tests did not run; this is the runner's mirror, so rerun the job."
    exit 1
  fi
  if [ -n "$apt_cache" ]; then
    mkdir -p "$apt_cache"
    downloaded=("$system_archives"/*.deb)
    [ "${#downloaded[@]}" -gt 0 ] && cp -- "${downloaded[@]}" "$apt_cache/"
    echo "Kept ${#downloaded[@]} apt packages for the cache" >&2
  fi
fi

if ! retry "Playwright $browser browser download" 300 false \
  pnpm --filter @sipges/e2e exec playwright install "$browser"; then
  echo "::error title=Playwright browser download::The Playwright $browser browser download failed in 3 attempts. The tests did not run; this is the browser CDN, so rerun the job."
  exit 1
fi
