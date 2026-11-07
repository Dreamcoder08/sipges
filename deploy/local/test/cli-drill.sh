#!/usr/bin/env bash
# The CLI drill: a clean install, then sipgesctl signs in, enrols MFA and runs `verify`, the whole
# behavioural journey over real HTTPS, against the real database roles. Synthetic values only, on
# its own project, ports and folder, so it never touches a real installation on the machine.
#   deploy/local/test/cli-drill.sh [work directory]
# Needs an image built by ./sipges install or SIPGES_DRILL_BUILD=1 to build it, and Go.
set -Eeuo pipefail
here=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
local_dir=$(dirname "$here")
repo_root=$(cd "$local_dir/../.." && pwd)
work=${1:-$(mktemp -d)}
mkdir -p "$work/backups"
export SIPGES_PROJECT=sipges-cli-drill
export SIPGES_ENV_FILE="$work/drill.env"
sipges() { "$local_dir/sipges" "$@"; }
step() { printf '\n== %s\n' "$*"; }
in_compose() {
  docker compose --env-file "$SIPGES_ENV_FILE" -p "$SIPGES_PROJECT" -f "$local_dir/compose.yaml" "$@"
}

cleanup() { in_compose --profile ops down --volumes --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

https_port=${SIPGES_CLI_DRILL_HTTPS_PORT:-18643}
password=synthetic-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
hex() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
umask 077
cat >"$SIPGES_ENV_FILE" <<ENV
SIPGES_SITE_HOST=localhost
SIPGES_ADMIN_USERNAME=admin
SIPGES_ADMIN_PASSWORD=$password
SIPGES_DATA_KEY=$(head -c 32 /dev/urandom | base64 | tr -d '\n')
SIPGES_BACKUP_PASSPHRASE=$(hex)
SIPGES_DB_ADMIN_PASSWORD=$(hex)
SIPGES_DB_PASSWORD=$(hex)
SIPGES_DB_BACKUP_PASSWORD=$(hex)
SIPGES_HOST_OWNER=$(id -u):$(id -g)
SIPGES_BACKUP_DIR=$work/backups
SIPGES_BIND_ADDRESS=127.0.0.1
SIPGES_HTTP_PORT=$((https_port - 1))
SIPGES_HTTPS_PORT=$https_port
ENV
umask 022

if [[ ${SIPGES_DRILL_BUILD:-0} == 1 ]]; then
  sipges build
fi

step 'build sipgesctl'
(cd "$repo_root/apps/api-go" && go build -o "$work/sipgesctl" ./cmd/sipgesctl)
ctl="$work/sipgesctl"

step 'install on empty volumes'
cleanup
sipges start
(cd "$work" && in_compose cp caddy:/data/caddy/pki/authorities/local/root.crt "$work/ca.crt")
export SIPGES_URL="https://localhost:$https_port" SIPGES_CA_FILE="$work/ca.crt"
export SIPGES_SESSION_FILE="$work/session.json" SIPGES_USERNAME=admin

step 'sign in and enrol MFA through the CLI'
"$ctl" call GET /health --json >/dev/null
if "$ctl" session --json >/dev/null 2>&1; then
  echo 'a session exists before signing in'
  exit 1
fi
SIPGES_PASSWORD=$password "$ctl" login </dev/null >/dev/null
"$ctl" mfa enroll --secret-file "$work/totp" --json >/dev/null
SIPGES_PASSWORD=$password "$ctl" login --totp-secret-file "$work/totp" </dev/null >/dev/null
"$ctl" session --json >"$work/session-state.json"
grep -q '"role": "admin"' "$work/session-state.json"
echo 'ok - the administrator signed in with MFA'

step 'every route has a CLI path'
routes=$("$ctl" routes --json | grep -c '"reach"')
((routes >= 138)) || { echo "the inventory has $routes routes"; exit 1; }
echo "ok - $routes routes in the inventory"

step 'the whole journey'
"$ctl" verify --synthetic-target | tee "$work/verify.txt"

step 'nothing secret in what the CLI printed'
secret=$(cat "$work/totp")
if grep -qF -e "$password" -e "$secret" "$work/verify.txt" "$work/session-state.json"; then
  echo 'a credential reached the output'
  exit 1
fi
mode=$(stat -c %a "$work/session.json")
[[ $mode == 600 ]] || { echo "session file mode $mode"; exit 1; }
echo 'ok - no credential in the output, and the session file is private'

step 'signing out ends the session'
"$ctl" logout >/dev/null
status=0
"$ctl" session --url "$SIPGES_URL" --json >/dev/null 2>&1 || status=$?
[[ $status == 3 ]] || { echo "session after logout: exit $status"; exit 1; }
echo 'ok - exit 3 after signing out'
