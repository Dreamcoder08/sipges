#!/bin/sh
# One-time setup of the SIPGES desktop app on Linux: builds the web app from this checkout,
# creates the state folder with its secrets, and adds the launcher entry and icon. Safe to
# rerun after `git pull`; existing secrets are kept. Read deploy/desktop/README.md first.
set -eu

HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
LAUNCHER="$HERE/sipges-desktop.sh"
STATE=${SIPGES_DESKTOP_STATE:-$HOME/.local/share/sipges-local}
DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share}

say() { printf '%s\n' "$*"; }
die() { printf 'SIPGES: %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die 'curl is required: install it with your package manager and try again.'
command -v openssl >/dev/null 2>&1 || die 'openssl is required: install it with your package manager and try again.'
command -v node >/dev/null 2>&1 || die 'Node.js 24 or later is required: install it and run this script again.'
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ] ||
  die 'Node.js 24 or later is required: install it and run this script again.'

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

mkdir -p "$DATA_HOME/applications" "$DATA_HOME/icons/hicolor/512x512/apps"
cp "$HERE/../sipges.png" "$DATA_HOME/icons/hicolor/512x512/apps/sipges.png"
cat >"$DATA_HOME/applications/sipges.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=SIPGES
Comment=SIPGES on this computer
Exec="$LAUNCHER"
Icon=sipges
Terminal=false
Categories=Office;
StartupWMClass=SIPGES
EOF
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DATA_HOME/applications" >/dev/null 2>&1 || true
fi

say 'SIPGES is installed. Open it from the application launcher.'
say "Admin user: admin. Password: $STATE/admin-password"
say "Back up the whole folder $STATE (it holds your data and its key)."
