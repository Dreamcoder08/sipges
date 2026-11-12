#!/bin/sh
# One-time setup of the SIPGES desktop app on Linux. Read deploy/desktop/README.md first.
#
#   install.sh                     clone mode: builds the web app from this checkout, creates the
#                                  state folder with its secrets, and adds the launcher entry and
#                                  icon. Safe to rerun after `git pull`; existing secrets are kept.
#   install.sh --managed <release> managed mode: installs a signed release into an install root
#                                  beside the state folder (which stays where it is) and points
#                                  the launcher entry at that root, so updates arrive through the
#                                  update notice. A rerun keeps the installed version.
set -eu

HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
LAUNCHER="$HERE/sipges-desktop.sh"
UPDATER="$HERE/../updater"
STATE_GIVEN=${SIPGES_DESKTOP_STATE:-}
STATE=${SIPGES_DESKTOP_STATE:-$HOME/.local/share/sipges-local}
DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share}
APP_ROOT=${SIPGES_DESKTOP_ROOT:-$DATA_HOME/sipges-app}
PORT=${SIPGES_DESKTOP_PORT:-8000}
USAGE='Usage: install.sh [--managed <signed release folder>]'

say() { printf '%s\n' "$*"; }
die() { printf 'SIPGES: %s\n' "$*" >&2; exit 1; }

RELEASE=
case "$#:${1:-}" in
  0:) ;;
  2:--managed) RELEASE=$2 ;;
  *) die "$USAGE" ;;
esac

command -v curl >/dev/null 2>&1 || die 'curl is required: install it with your package manager and try again.'
command -v openssl >/dev/null 2>&1 || die 'openssl is required: install it with your package manager and try again.'
command -v node >/dev/null 2>&1 || die 'Node.js 24 or later is required: install it and run this script again.'
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ] ||
  die 'Node.js 24 or later is required: install it and run this script again.'

# The launcher entry and icon, pointing at the given script.
write_entry() {
  mkdir -p "$DATA_HOME/applications" "$DATA_HOME/icons/hicolor/512x512/apps"
  cp "$HERE/../sipges.png" "$DATA_HOME/icons/hicolor/512x512/apps/sipges.png"
  cat >"$DATA_HOME/applications/sipges.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=SIPGES
Comment=SIPGES on this computer
Exec="$1"
Icon=sipges
Terminal=false
Categories=Office;
StartupWMClass=SIPGES
EOF
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$DATA_HOME/applications" >/dev/null 2>&1 || true
  fi
}

# True when the folder exists and holds at least one entry, hidden ones included.
has_entries() {
  for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    if [ -e "$entry" ]; then return 0; fi
  done
  return 1
}

# True when the file exists and holds something besides blanks.
has_text() {
  [ -f "$1" ] && [ -n "$(tr -d ' \t\r\n' <"$1")" ]
}

# The folder's real path when it exists, otherwise the name as given.
real_dir() {
  if [ -d "$1" ]; then (cd "$1" && pwd -P); else printf '%s\n' "$1"; fi
}

# Managed mode. Nothing is written before every check passed; the state folder is never moved,
# overwritten or deleted: only missing secrets are created, as in clone mode.
install_managed() {
  [ -d "$RELEASE" ] || die "not a signed release (no such folder): $RELEASE"
  RELEASE=$(cd "$RELEASE" && pwd)
  [ -f "$RELEASE/release.json" ] && [ -f "$RELEASE/release.sig" ] && [ -d "$RELEASE/package" ] ||
    die "not a signed release (release.json, release.sig and package/ are needed): $RELEASE"
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    die "SIPGES is running on this computer (port $PORT): close it, end its node process or restart, and run this script again."
  fi
  # A rerun keeps the state folder the install recorded: another one would be prepared and named
  # here while SIPGES keeps opening the recorded one.
  if [ -f "$APP_ROOT/install.json" ]; then
    recorded=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).stateDir' "$APP_ROOT/install.json") ||
      die "no se pudo leer $APP_ROOT/install.json; no se cambió nada."
    if [ -n "$STATE_GIVEN" ] && [ "$(real_dir "$STATE")" != "$recorded" ]; then
      die "esta instalación usa la carpeta de datos $recorded, no $STATE: vuelve a ejecutar el script sin SIPGES_DESKTOP_STATE o con SIPGES_DESKTOP_STATE=$recorded; no se cambió nada."
    fi
    STATE=$recorded
  fi
  # An existing database keeps its own key: a new one would leave its sealed values unreadable.
  if has_entries "$STATE/pglite" && ! has_text "$STATE/data-key"; then
    die "the state folder $STATE holds a database but its data-key is missing or empty: restore it from your backup of that folder and run this script again; nothing was changed."
  fi
  # Nor a new admin password: the database keeps the account made with the old one, so a new
  # file would be printed as the password while it opens nothing.
  if has_entries "$STATE/pglite" && ! has_text "$STATE/admin-password"; then
    die "la carpeta de datos $STATE tiene una base de datos pero falta su admin-password o está vacía: restáurala desde tu respaldo de esa carpeta y vuelve a ejecutar este script; no se cambió nada."
  fi
  had_state=no
  [ ! -e "$STATE" ] || had_state=yes
  umask 077
  if [ -f "$APP_ROOT/current.json" ]; then
    say "SIPGES is already installed: $(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "$APP_ROOT/current.json"). Updates arrive through the update notice; only the launcher entry is refreshed."
  else
    mkdir -p "$APP_ROOT"
    node "$UPDATER/update.mjs" --install "$APP_ROOT" --release "$RELEASE" --state "$STATE" --trust-release-key ||
      die 'the signed release could not be installed; the state folder was not changed.'
  fi
  SIPGES_DESKTOP_STATE="$STATE" "$LAUNCHER" --prepare
  mkdir -p "$APP_ROOT/releases"
  cp "$UPDATER/run-current.mjs" "$APP_ROOT/run-current.mjs"
  cp "$HERE/sipges-managed.sh" "$APP_ROOT/sipges-desktop.sh"
  chmod 755 "$APP_ROOT/sipges-desktop.sh"
  write_entry "$APP_ROOT/sipges-desktop.sh"
  say 'SIPGES is installed. Open it from the application launcher.'
  say "Install root: $APP_ROOT. Copy newer signed releases into $APP_ROOT/releases to be offered them."
  say "Admin user: admin. Password: $STATE/admin-password"
  if [ "$had_state" = yes ] && [ ! -f "$APP_ROOT/first-start.json" ]; then
    say "The existing state folder $STATE was kept as it is. Its first start copies it beside itself ($STATE.pre-update-<time>-first-start-$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "$APP_ROOT/current.json")), migrates a second copy and only then the folder."
    say "Back it up yourself as well before opening SIPGES."
  fi
  say "Back up the whole folder $STATE (it holds your data and its key)."
}

if [ -n "$RELEASE" ]; then
  install_managed
  exit 0
fi

# shellcheck disable=SC2016 # the backticks name a command for the person to run
ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1 && [ "$(pnpm --version | cut -d. -f1)" = 12 ]; then return 0; fi
  npm install -g pnpm@12.11.2 && command -v pnpm >/dev/null 2>&1 && [ "$(pnpm --version | cut -d. -f1)" = 12 ] ||
    die 'pnpm could not be installed: run `npm install -g pnpm@12.11.2` in a new terminal and run this script again.'
}
ensure_pnpm

cd "$REPO"
pnpm install --frozen-lockfile
pnpm --filter @sipges/web build

"$LAUNCHER" --prepare
write_entry "$LAUNCHER"

say 'SIPGES is installed. Open it from the application launcher.'
say "Admin user: admin. Password: $STATE/admin-password"
say "Back up the whole folder $STATE (it holds your data and its key)."
