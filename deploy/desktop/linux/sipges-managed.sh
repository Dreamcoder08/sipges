#!/bin/sh
# Opens a managed SIPGES install (install.sh --managed) as a desktop app. install.sh copies this
# script into the install root as sipges-desktop.sh and the launcher entry runs that copy, so it
# keeps working after updates. It reuses the local server when it answers; otherwise it starts
# run-current.mjs (the launcher of the current version, which checks <root>/releases for updates),
# opens the browser in app mode and stays with the launcher: if an update cannot be rolled back
# (exit code 3) the person gets the notice naming the copy to restore. Read deploy/desktop/README.md.
set -eu

ROOT=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
PORT=${SIPGES_DESKTOP_PORT:-8000}
URL=http://localhost:$PORT
PROBE=http://127.0.0.1:$PORT/health
WAIT_SECONDS=${SIPGES_DESKTOP_WAIT:-90}
# Outside the state folder: an update copies and may move that folder while SIPGES runs.
LOG="$ROOT/launcher.log"
HALT_EXIT=3
HALT_FALLBACK='SIPGES no se inició: una actualización falló y sus datos no se pudieron restaurar. No borre nada. Restaure la copia de seguridad previa a la actualización (la carpeta <carpeta de datos>.pre-update-… junto a la carpeta de datos) o contacte con soporte.'

say() { printf '%s\n' "$*"; }

notify() {
  if command -v notify-send >/dev/null 2>&1; then
    notify-send --urgency=critical SIPGES "$1" || true
  elif command -v zenity >/dev/null 2>&1; then
    zenity --error --title=SIPGES --text="$1" || true
  fi
}

fail() {
  say "SIPGES: $*" >&2
  notify "$*"
  exit 1
}

# The launcher's own notice (the last one in the log) names the pre-update copy to restore.
halt() {
  notice=
  if [ -f "$LOG" ]; then
    while IFS= read -r line; do
      case $line in 'SIPGES no se inició'*) notice=$line ;; esac
    done <"$LOG"
  fi
  [ -n "$notice" ] || notice=$HALT_FALLBACK
  say "$notice" >&2
  notify "$notice"
  exit "$HALT_EXIT"
}

healthy() { curl -fsS --max-time 2 "$PROBE" >/dev/null 2>&1; }

start_launcher() {
  command -v node >/dev/null 2>&1 || fail 'Node.js is not installed'
  nohup node "$ROOT/run-current.mjs" --releases "$ROOT/releases" --port "$PORT" \
    >>"$LOG" 2>&1 </dev/null &
  LAUNCHER_PID=$!
}

# Ends the script when the launcher is gone: the halt notice for code 3, otherwise its code.
launcher_ended() {
  kill -0 "$LAUNCHER_PID" 2>/dev/null && return 0
  code=0
  wait "$LAUNCHER_PID" || code=$?
  [ "$code" -ne "$HALT_EXIT" ] || halt
  [ "${1:-}" != starting ] || fail "SIPGES stopped while starting (code $code); see $LOG"
  exit "$code"
}

wait_for_server() {
  waited=0
  while :; do
    healthy && return 0
    launcher_ended starting
    [ "$waited" -lt "$WAIT_SECONDS" ] || fail "SIPGES did not start in ${WAIT_SECONDS} s; see $LOG"
    sleep 1
    waited=$((waited + 1))
  done
}

# Its own browser profile, outside the state folder (a live profile holds links and sockets,
# which an update refuses to copy). `exec` replaces this script; `background` keeps it.
open_browser() {
  for candidate in google-chrome-stable chromium microsoft-edge brave; do
    if command -v "$candidate" >/dev/null 2>&1; then
      set -- "$1" "$candidate" --app="$URL" --class=SIPGES --user-data-dir="$ROOT/browser"
      break
    fi
  done
  [ "$#" -gt 1 ] || set -- "$1" xdg-open "$URL"
  mode=$1
  shift
  if [ "$mode" = exec ]; then exec "$@"; fi
  "$@" &
}

if healthy; then open_browser exec; fi
start_launcher
wait_for_server
open_browser background
# Stay with the launcher: an update after the click can still end in a halt.
code=0
wait "$LAUNCHER_PID" || code=$?
[ "$code" -ne "$HALT_EXIT" ] || halt
exit "$code"
