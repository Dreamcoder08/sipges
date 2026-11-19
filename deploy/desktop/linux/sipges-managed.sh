#!/bin/sh
# Opens a managed SIPGES install (install.sh --managed) as a desktop app. install.sh copies this
# script into the install root as sipges-desktop.sh and the launcher entry runs that copy, so it
# keeps working after updates. It reuses the local server when it answers; otherwise it starts
# the launcher of the install, opens the browser in app mode and stays with the launcher: if an
# update cannot be rolled back (exit code 3) the person gets the notice naming the copy to
# restore. Read deploy/desktop/README.md.
# Which launcher (go-rust-stack T72d3): the current version's Go launcher, go/sipges-desktop
# --install <root> --releases <root>/releases, when that version has it with PostgreSQL 18 (its
# postgresql/bin, else SIPGES_PG_BIN) and the state folder install.json records is in pg18 (or
# holds no PGlite data yet, as a new install). It checks <root>/releases for updates and needs
# no Node. Otherwise, data still only in PGlite until the visit moves them, run-current.mjs (the
# TypeScript launcher of the current version, with Node). Output is appended to launcher.log.
# --go asks for the Go launcher only: it refuses, before starting anything, a version built
# without --go and a state folder whose data are still only in PGlite.
set -eu
FORCE_GO=
[ "${1:-}" != --go ] || FORCE_GO=1

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

# A string field of a JSON file in the install root. sed reads the files the updaters write
# (no Node needed); a value it cannot read plainly (escapes) is left to node when there is one.
json_field() {
  [ -f "$ROOT/$1" ] || return 1
  value=
  command -v sed >/dev/null 2>&1 && value=$(tr -d '\n\r' <"$ROOT/$1" 2>/dev/null |
    sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"\\\\]*\)\"[[:space:]]*[,}].*/\1/p") || value=
  if [ -n "$value" ]; then printf '%s' "$value"; return 0; fi
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]; if (typeof v !== "string") process.exit(1); process.stdout.write(v)' "$ROOT/$1" "$2" 2>/dev/null
}

# Sets GO_EXE and PG_BIN for the Go launcher of the current version, or prints why it cannot
# run (a version without the Go mode, data not moved yet: something in pglite/ and no cluster in
# pg18/, where a new one would start SIPGES empty) and returns 1. Changes nothing.
resolve_go() {
  if ! release=$(json_field current.json path) || ! state=$(json_field install.json stateDir); then
    say "SIPGES no está instalado correctamente en $ROOT. Vuelva a ejecutar el instalador."
    return 1
  fi
  case $release in /*) ;; *) release="$ROOT/$release" ;; esac
  if [ ! -x "$release/go/sipges-desktop" ]; then
    say 'Esta versión de SIPGES no incluye el modo Go. Abra SIPGES desde su acceso directo habitual.'
    return 1
  fi
  PG_BIN=${SIPGES_PG_BIN:-}
  [ ! -x "$release/postgresql/bin/pg_ctl" ] || PG_BIN="$release/postgresql/bin"
  if [ -z "$PG_BIN" ]; then
    say 'No se encontró PostgreSQL 18 para el modo Go: indique la carpeta bin de PostgreSQL 18 en SIPGES_PG_BIN.'
    return 1
  fi
  # A cluster --prepare-only made stays empty until the move commits and removes pg18.pending-move.
  if [ -e "$state/pg18.pending-move" ] ||
    { [ -n "$(ls -A "$state/pglite" 2>/dev/null)" ] && [ ! -f "$state/pg18/PG_VERSION" ]; }; then
    say 'SIPGES no se inició en modo Go: sus datos todavía no se movieron a PostgreSQL. No se tocó nada. Abra SIPGES desde su acceso directo habitual.'
    return 1
  fi
  GO_EXE="$release/go/sipges-desktop"
}

# The Go launcher of the install: recovery, first start, the update check of <root>/releases and
# the update the person accepts in the app; exit code 3 is the same halt as the TypeScript one.
start_go() {
  SIPGES_PG_BIN=$PG_BIN nohup "$GO_EXE" --install "$ROOT" --releases "$ROOT/releases" --port "$PORT" \
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

# The program listening on the port, by the name it was started with (api: the Go API, node:
# TypeScript; ss shows a thread name instead); empty when unknown.
server_image() {
  pid=$(ss -Hltnp "sport = :$PORT" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -n 1)
  [ -n "$pid" ] || return 0
  argv0=$(tr '\0' '\n' <"/proc/$pid/cmdline" 2>/dev/null | head -n 1)
  [ -z "$argv0" ] || basename "$argv0"
}

# A SIPGES that answers is opened only in the install's mode: the Go mode never reuses the
# TypeScript one (writes would go to PGlite) nor an unknown one, the TypeScript mode never the Go one.
assert_served_mode() {
  image=$(server_image)
  if [ -n "$GO_MODE" ] && [ "$image" != api ]; then
    fail 'SIPGES ya está abierto sin el modo Go. Ciérrelo antes de abrirlo en modo Go.'
  fi
  if [ -z "$GO_MODE" ] && [ "$image" = api ]; then
    fail 'SIPGES ya está abierto en modo Go. Ciérrelo antes de abrirlo sin el modo Go.'
  fi
}

GO_MODE=
if why=$(resolve_go); then
  GO_MODE=1
  resolve_go >/dev/null
elif [ -n "$FORCE_GO" ]; then
  fail "$why"
fi
if healthy; then
  assert_served_mode
  open_browser exec
fi
if [ -n "$GO_MODE" ]; then start_go; else start_launcher; fi
wait_for_server
open_browser background
# Stay with the launcher: an update after the click can still end in a halt.
code=0
wait "$LAUNCHER_PID" || code=$?
[ "$code" -ne "$HALT_EXIT" ] || halt
exit "$code"
