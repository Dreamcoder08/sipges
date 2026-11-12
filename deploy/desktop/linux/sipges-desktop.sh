#!/bin/sh
# Opens SIPGES as a desktop app: reuses the local server when it answers, otherwise starts it
# from this checkout, then opens the browser in app mode. `--prepare` only creates the state
# folder and its secrets (install.sh uses it). Read deploy/desktop/README.md first.
set -eu

REPO=$(cd "$(dirname "$(readlink -f "$0")")/../../.." && pwd)
STATE=${SIPGES_DESKTOP_STATE:-$HOME/.local/share/sipges-local}
URL=http://localhost:8000
PROBE=http://127.0.0.1:8000/health
WAIT_SECONDS=${SIPGES_DESKTOP_WAIT:-90}

say() { printf '%s\n' "$*"; }

fail() {
  say "SIPGES: $*" >&2
  if command -v notify-send >/dev/null 2>&1; then notify-send SIPGES "$*" || true; fi
  exit 1
}

need_tools() {
  command -v curl >/dev/null 2>&1 || fail 'curl is required: install it with your package manager and try again.'
  command -v openssl >/dev/null 2>&1 || fail 'openssl is required: install it with your package manager and try again.'
}

# True when the file holds something other than whitespace.
has_content() { [ -f "$1" ] && [ -n "$(tr -d ' \t\r\n' <"$1")" ]; }

# Creates the state folder and each secret once; an existing secret is never rewritten, only
# its permissions are tightened. A blank file holds no secret and is replaced.
prepare_state() {
  umask 077
  mkdir -p "$STATE/pglite" "$STATE/uploads"
  chmod 700 "$STATE"
  if ! has_content "$STATE/data-key"; then
    openssl rand -base64 32 >"$STATE/data-key" || fail 'could not create the data key'
  fi
  if ! has_content "$STATE/admin-password"; then
    openssl rand -base64 24 | tr -d '/+=\n' >"$STATE/admin-password" || fail 'could not create the admin password'
  fi
  chmod 600 "$STATE/data-key" "$STATE/admin-password"
}

healthy() { curl -fsS --max-time 2 "$PROBE" >/dev/null 2>&1; }

start_server() {
  command -v node >/dev/null 2>&1 || fail 'Node.js is not installed'
  cd "$REPO"
  SIPGES_DATA_KEY=$(cat "$STATE/data-key") \
    SIPGES_ADMIN_PASSWORD=$(cat "$STATE/admin-password") \
    SIPGES_COOKIE_SECURE=0 \
    SIPGES_HOST=127.0.0.1 \
    SIPGES_PGLITE_DIR="$STATE/pglite" \
    SIPGES_UPLOAD_DIR="$STATE/uploads" \
    SIPGES_WEB_DIR="$REPO/apps/web/dist" \
    nohup node apps/api/src/main.ts >>"$STATE/api.log" 2>&1 </dev/null &
}

wait_for_server() {
  waited=0
  while [ "$waited" -lt "$WAIT_SECONDS" ]; do
    healthy && return 0
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

open_browser() {
  for browser in google-chrome-stable chromium microsoft-edge brave; do
    if command -v "$browser" >/dev/null 2>&1; then
      exec "$browser" --app="$URL" --class=SIPGES --user-data-dir="$STATE/chrome"
    fi
  done
  exec xdg-open "$URL"
}

need_tools
prepare_state
if [ "${1:-}" = --prepare ]; then exit 0; fi

if ! healthy; then
  start_server
  wait_for_server || fail "the server did not start in ${WAIT_SECONDS} s; see $STATE/api.log"
fi
open_browser
