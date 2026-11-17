#!/usr/bin/env bash
# Fast checks of ./sipges with a stand-in for Docker: no image, no container, under a minute. They
# pin what the drills cannot see, such as the order of a refusal and a build. Synthetic data only.
#   deploy/local/test/unit.sh
set -Eeuo pipefail
here=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
script=$(dirname "$here")/sipges
root=$(mktemp -d)
failures=0

cat >"$root/docker" <<'FAKE'
#!/usr/bin/env bash
# Answers like Docker from the files in $FAKE, and logs every call to $FAKE/calls.
image_file() { printf '%s/images/%s' "$FAKE" "${1//[:\/]/_}"; }
printf '%s\n' "$*" >>"$FAKE/calls"
[[ $1 != compose ]] || printf '%s\n' "${SIPGES_API_UPSTREAMS-unset}" >>"$FAKE/upstreams"
case $1 in
compose)
  shift # compose, then --env-file <file> -p <project> -f compose.yaml [-f <override>] [--profile <name>]
  while [[ ${1:-} == --env-file || ${1:-} == -p || ${1:-} == -f || ${1:-} == --profile ]]; do shift 2; done
  case $1 in
  version | config) exit 0 ;;
  ps)
    if [[ $* == *api* ]]; then cat "$FAKE/api-container" 2>/dev/null; else echo db-container; fi
    ;;
  exec)
    [[ $* != *caddy* || ! -f $FAKE/not-ready ]] || exit 1
    [[ $* != *https://127.0.0.1/* || ! -f $FAKE/proxy-down ]] || exit 1
    [[ $* != *caddy* ]] || echo '{"status":"ready"}'
    ;;
  run)
    [[ $* != *migrate* || ! -f $FAKE/migrate-fails ]] || exit 1
    echo "gid=${SIPGES_HOST_GID:-unset}" >"$FAKE/run-env"
    stat -c '%a %g' "$SIPGES_IMPORT_REPORTS" >"$FAKE/reports-during-run"
    for arg in "$@"; do
      if [[ ${previous:-} == --report ]]; then echo '{}' >"$SIPGES_IMPORT_REPORTS/${arg#/reports/}"; fi
      previous=$arg
    done
    ;;
  esac
  ;;
info) ;;
ps)
  # Containers this project left behind, by service label.
  cat "$FAKE/stale-api-2" 2>/dev/null
  ;;
inspect)
  # One health answer per call; the last one repeats.
  head -n 1 "$FAKE/health"
  if (($(wc -l <"$FAKE/health") > 1)); then sed -i 1d "$FAKE/health"; fi
  ;;
image)
  name=${*: -1}
  [[ -f $(image_file "$name") ]] || exit 1
  cat "$(image_file "$name")"
  ;;
tag)
  cp "$(image_file "$2")" "$(image_file "$3")"
  ;;
build)
  [[ ! -f $FAKE/build-fails ]] || exit 1
  while [[ $# -gt 0 ]]; do
    if [[ $1 == -t ]]; then tag=$2; fi
    shift
  done
  count=$(($(cat "$FAKE/builds" 2>/dev/null || echo 0) + 1))
  echo "$count" >"$FAKE/builds"
  if [[ -f $FAKE/same-build ]]; then count=same; fi
  echo "sha256:$count" >"$(image_file "$tag")"
  ;;
run)
  # The image's key generator: a new pair each call.
  if [[ $* == *vapid-keys* ]]; then
    [[ ! -f $FAKE/vapid-fails ]] || exit 1
    if [[ -f $FAKE/vapid-empty ]]; then exit 0; fi
    count=$(($(cat "$FAKE/vapid" 2>/dev/null || echo 0) + 1))
    echo "$count" >"$FAKE/vapid"
    printf 'SIPGES_VAPID_PUBLIC_KEY=public-%s\nSIPGES_VAPID_PRIVATE_KEY=private-%s\n' "$count" "$count"
  fi
  ;;
esac
FAKE
printf '#!/usr/bin/env bash\n' >"$root/sleep"
# No repository for update to pull from: the tests never touch the checkout they run in.
printf '#!/usr/bin/env bash\nexit 1\n' >"$root/git"
chmod +x "$root/docker" "$root/sleep" "$root/git"

# A clean install for one test: an .env, a stand-in Docker and a client folder only its owner's
# group may read.
fresh() {
  work=$(mktemp -d -p "$root")
  export FAKE=$work/fake SIPGES_ENV_FILE=$work/env SIPGES_IMPORT_REPORTS=$work/reports
  unset SIPGES_IMAGE_TAG SIPGES_SKIP_BUILD
  mkdir -p "$FAKE/images" "$work/backups" "$work/client/nested"
  echo healthy >"$FAKE/health"
  echo synthetic >"$work/client/nested/file.txt"
  chmod -R u=rwX,g=rX,o= "$work/client"
  cat >"$SIPGES_ENV_FILE" <<ENV
SIPGES_SITE_HOST=localhost
SIPGES_BACKUP_DIR=$work/backups
SIPGES_BACKUP_HOUR=2
ENV
}
run() { PATH="$root:$PATH" "$script" "$@" >"$work/out" 2>&1; }
image_id() { cat "$FAKE/images/sipges-local_$1"; }
ok() { printf 'ok   - %s\n' "$1"; }
fail() {
  printf 'FAIL - %s\n' "$1"
  failures=$((failures + 1))
}
check() {
  local name=$1
  shift
  if "$@"; then ok "$name"; else fail "$name"; fi
}
said() { grep -qF -- "$1" "$work/out"; }
not_said() { ! said "$1"; }
called() { grep -qF -- "$1" "$FAKE/calls"; }
never_built() { ! called ' build ' && ! grep -q '^build' "$FAKE/calls"; }

# --- the reports folder and the client's folder

fresh
run import base-maestra "$work/client/nested/file.txt" || true
[[ -f $FAKE/reports-during-run ]] || cat "$work/out"
read -r mode group <"$FAKE/reports-during-run" || true
check 'the reports folder is not open to other users during an import' \
  test "$((8#${mode:-777} & 8#007))" -eq 0
check 'the reports folder belongs to the installing user group' test "${group:-}" = "$(id -g)"
check 'and that group may write there while the import runs' test "$((8#${mode:-0} & 8#070))" -eq "$((8#070))"
check 'the import runs with that group' grep -qx "gid=$(id -g)" "$FAKE/run-env"
check 'the reports folder closes after the import' test "$(stat -c %a "$SIPGES_IMPORT_REPORTS")" = 700

fresh
run import base-maestra "$work/client/nested/file.txt" || true
check 'a client folder only the group reads is accepted' test -f "$FAKE/reports-during-run"

fresh
chmod -R go= "$work/client"
if run import base-maestra "$work/client/nested/file.txt"; then fail 'a folder only its owner reads is refused'; else ok 'a folder only its owner reads is refused'; fi
check 'the refusal names the group, not everyone' said 'g+rX,o-rwx'
check 'the refusal never suggests opening the copy to all' test -z "$(grep -F 'a+r' "$work/out" || true)"

fresh
chmod -R a+rX "$work/client"
run import base-maestra "$work/client/nested/file.txt" || true
check 'a folder other users can read is pointed out' said 'other users of this computer can read'

fresh
cat >"$root/getent" <<'FAKE'
#!/usr/bin/env bash
[[ $1 != group ]] || echo 'shared:x:0:someone-else'
FAKE
chmod +x "$root/getent"
if run import base-maestra "$work/client/nested/file.txt"; then fail 'a group shared with other accounts is refused'; else ok 'a group shared with other accounts is refused'; fi
check 'nothing ran under a shared group' test ! -f "$FAKE/reports-during-run"
command rm "$root/getent"

# --- the inventory

fresh
echo sha256:1 >"$FAKE/images/sipges-local_current"
chmod 000 "$work/client/nested/file.txt"
run inventory "$work/client"
check 'the inventory takes a folder with an unreadable file: that file is a line of the report' test -f "$FAKE/reports-during-run"
check 'it never starts the database' test -z "$(grep -F ' up ' "$FAKE/calls" || true)"
check 'it runs the inventory service' called 'run --rm inventory inventory --root /import --report /reports/inventory-'
check 'it names the report' said "$work/reports/inventory-"
check 'the reports folder closes after it too' test "$(stat -c %a "$SIPGES_IMPORT_REPORTS" | tail -c 4)" = 700

fresh
echo sha256:1 >"$FAKE/images/sipges-local_current"
run inventory "$work/client" --show-unconfirmed-headers
check 'the owner may ask for unconfirmed headers' called '--show-unconfirmed-headers'

fresh
echo sha256:1 >"$FAKE/images/sipges-local_current"
if run inventory "$work/client" --apply; then fail 'the inventory has no --apply'; else ok 'the inventory has no --apply'; fi
check 'and ran nothing' test ! -f "$FAKE/reports-during-run"

fresh
if run inventory "$work/client"; then fail 'an install that was never built is refused'; else ok 'an install that was never built is refused'; fi
check 'and it says what to run' said './sipges prepare'

fresh
echo sha256:1 >"$FAKE/images/sipges-local_current"
if run inventory "$(dirname "$script")"; then fail 'a folder inside the repository is refused'; else ok 'a folder inside the repository is refused'; fi
if run inventory "$work/no-such-folder"; then fail 'a missing folder is refused'; else ok 'a missing folder is refused'; fi
if run inventory; then fail 'no folder is refused'; else ok 'no folder is refused'; fi
fresh
export SIPGES_IMPORT_REPORTS="$work/it's reports"
run import base-maestra "$work/client/nested/file.txt" || true
check 'a quote in the reports path still closes the folder' test "$(stat -c %a "$SIPGES_IMPORT_REPORTS")" = 700

fresh
chmod -R go= "$work/client"
run import base-maestra "$work/client/nested/file.txt" || true
check 'a refused folder never builds the import tools' never_built

fresh
run import unknown "$work/client" || true
check 'an unknown import never builds them either' never_built

# --- an import right after a reboot

fresh
printf 'starting\nstarting\nhealthy\n' >"$FAKE/health"
run import base-maestra "$work/client/nested/file.txt" || true
check 'the import waits for a healthy database' \
  test "$(grep -n ' run ' "$FAKE/calls" | head -n 1 | cut -d: -f1)" -gt "$(grep -n '^inspect' "$FAKE/calls" | tail -n 1 | cut -d: -f1)"

fresh
printf 'starting\nstarting\nhealthy\n' >"$FAKE/health"
run import base-maestra "$work/client/nested/file.txt" --apply || true
check 'the backup before an apply waits for it too' \
  test "$(grep -n 'backup.sh' "$FAKE/calls" | head -n 1 | cut -d: -f1)" -gt "$(grep -n '^inspect' "$FAKE/calls" | sed -n 3p | cut -d: -f1)"

fresh
echo starting >"$FAKE/health"
if run import base-maestra "$work/client/nested/file.txt"; then fail 'a database that never wakes stops the import'; else ok 'a database that never wakes stops the import'; fi
check 'and nothing ran' test ! -f "$FAKE/reports-during-run"
check 'and it says where to look' said 'logs db'

# --- refusals come before the build

fresh
echo 'SIPGES_BACKUP_HOUR=99' >>"$SIPGES_ENV_FILE"
run prepare || true
check 'prepare refuses a bad backup hour before building' never_built

fresh
echo 20261106T000000Z >"$work/backups/.restore-unfinished"
run prepare || true
check 'prepare refuses an unfinished restore before building' never_built
check 'and names the backup' said 20261106T000000Z

fresh
echo api-container >"$FAKE/api-container"
if run prepare; then fail 'prepare refuses once the app has run'; else ok 'prepare refuses once the app has run'; fi
check 'before building' never_built

fresh
echo 'SIPGES_BACKUP_HOUR=99' >>"$SIPGES_ENV_FILE"
run install || true
check 'install refuses before building' never_built

fresh
echo 'SIPGES_BACKUP_HOUR=99' >>"$SIPGES_ENV_FILE"
run update || true
check 'update refuses before backing up or building' never_built
check 'nor backed up' test -z "$(grep -F backup.sh "$FAKE/calls" || true)"

# --- the operator's compose override

base_compose() { printf 'compose --env-file %s -p sipges -f compose.yaml' "$SIPGES_ENV_FILE"; }
# Every compose call carries the override, and nothing else changed.
all_with() { ! grep '^compose --' "$FAKE/calls" | grep -vqF -- "$(base_compose) -f $1 "; }

fresh
run install
: >"$FAKE/calls"
run start
check 'without an override, start runs compose as before' called "$(base_compose) up -d db api caddy backup"
check 'and no call names a second file' test -z "$(grep -F -- '-f compose.yaml -f' "$FAKE/calls" || true)"

fresh
printf 'services: {}\n' >"$work/override.yaml"
echo "SIPGES_COMPOSE_OVERRIDE=$work/override.yaml" >>"$SIPGES_ENV_FILE"
run install
check 'install passes the override named in .env' called "$(base_compose) -f $work/override.yaml up -d db api caddy backup"
: >"$FAKE/calls"
run start
check 'start passes the override named in .env' called "$(base_compose) -f $work/override.yaml up -d db api caddy backup"
check 'to every compose call' all_with "$work/override.yaml"
: >"$FAKE/calls"
run update
check 'update passes it to the backup before updating' \
  called "$(base_compose) -f $work/override.yaml exec -T backup bash /ops/backup.sh"
check 'and to the start after it' called "$(base_compose) -f $work/override.yaml up -d db api caddy backup"
check 'and to every other compose call' all_with "$work/override.yaml"
: >"$FAKE/calls"
run stop
check 'stop passes it too' called "$(base_compose) -f $work/override.yaml stop"

fresh
run install
echo "SIPGES_COMPOSE_OVERRIDE=$work/missing.yaml" >>"$SIPGES_ENV_FILE"
: >"$FAKE/calls"
run start && started=yes || started=no
check 'an override that does not exist is refused' test "$started" = no
check 'and the refusal names the setting and the file' said "SIPGES_COMPOSE_OVERRIDE names $work/missing.yaml"
check 'and nothing started' test -z "$(grep -F ' up ' "$FAKE/calls" || true)"
: >"$FAKE/calls"
run stop || true
check 'stop refuses it too, rather than run without it' test -z "$(grep -F ' stop' "$FAKE/calls" || true)"
: >"$FAKE/calls"
run update || true
check 'update refuses it before backing up or building' never_built
check 'nor backing up' test -z "$(grep -F backup.sh "$FAKE/calls" || true)"

# --- device notifications get their keys once

fresh
chmod 600 "$SIPGES_ENV_FILE" # as ./sipges install writes it
run install
check 'an install adds a device-notification key pair' grep -qx 'SIPGES_VAPID_PUBLIC_KEY=public-1' "$SIPGES_ENV_FILE"
check 'with its private key' grep -qx 'SIPGES_VAPID_PRIVATE_KEY=private-1' "$SIPGES_ENV_FILE"
check 'and a contact the push services accept' grep -qx 'SIPGES_VAPID_SUBJECT=mailto:sipges@localhost' "$SIPGES_ENV_FILE"
check 'the .env stays readable by its owner only' test "$(stat -c %a "$SIPGES_ENV_FILE")" = 600
run start
check 'a later start keeps the same pair, so subscribed devices keep working' \
  test "$(grep -c '^SIPGES_VAPID_PUBLIC_KEY=' "$SIPGES_ENV_FILE")" = 1
check 'and asks for no new pair' test "$(cat "$FAKE/vapid")" = 1

fresh
printf 'SIPGES_VAPID_PUBLIC_KEY=mine\nSIPGES_VAPID_PRIVATE_KEY=mine-private\nSIPGES_VAPID_SUBJECT=mailto:a@b.c\n' >>"$SIPGES_ENV_FILE"
run install
check 'keys the operator set are never replaced' grep -qx 'SIPGES_VAPID_PUBLIC_KEY=mine' "$SIPGES_ENV_FILE"
check 'nor a new pair asked for' test ! -f "$FAKE/vapid"

fresh
printf 'SIPGES_ANALYST_MODEL=synthetic-model' >>"$SIPGES_ENV_FILE" # an operator's edit with no final newline
run install
check 'the line before the keys keeps its value' grep -qx 'SIPGES_ANALYST_MODEL=synthetic-model' "$SIPGES_ENV_FILE"
check 'and the keys are still added' grep -qx 'SIPGES_VAPID_PUBLIC_KEY=public-1' "$SIPGES_ENV_FILE"

fresh
printf 'SIPGES_VAPID_SUBJECT=mailto:ops@example.org\n' >>"$SIPGES_ENV_FILE"
run install
check 'a contact the operator set stays the only one' \
  test "$(grep -c '^SIPGES_VAPID_SUBJECT=' "$SIPGES_ENV_FILE")" = 1
check 'and keeps its value' grep -qx 'SIPGES_VAPID_SUBJECT=mailto:ops@example.org' "$SIPGES_ENV_FILE"

fresh
touch "$FAKE/vapid-fails"
before=$(cat "$SIPGES_ENV_FILE")
run install
check 'an image that cannot make keys still starts' said 'SIPGES is ready'
check 'says device notifications stay off' said 'Device notifications stay off'
check 'and leaves the .env as it was' test "$(cat "$SIPGES_ENV_FILE")" = "$before"

fresh
touch "$FAKE/vapid-empty"
before=$(cat "$SIPGES_ENV_FILE")
run install
check 'an empty answer writes no keys' test "$(cat "$SIPGES_ENV_FILE")" = "$before"

# --- previous points only at a build that started

fresh
run install
good=$(image_id current)
run install
started=$(image_id current)
check 'a started build becomes previous' test "$(image_id previous)" = "$good"
check 'and the new one is current' test "$started" != "$good"

touch "$FAKE/not-ready"
run install || true
broken=$(image_id current)
check 'an update keeps the last build that started as the way back' test "$(image_id previous)" = "$started"
run install || true
check 'a retry that never starts does not replace it' test "$(image_id previous)" = "$started"
check 'even though current moved' test "$(image_id current)" != "$broken"

command rm "$FAKE/not-ready"
run install
run install
check 'once one starts, previous follows again' test "$(image_id previous)" != "$started"

# Ready means the path people use: an API that answers while Caddy still counts it down is not.
touch "$FAKE/proxy-down"
run start || true
check 'an API that Caddy cannot reach yet is not reported ready' not_said 'SIPGES is ready.'
check 'and the readiness check goes through Caddy' called 'https://127.0.0.1/health/ready'
command rm "$FAKE/proxy-down"
run start
check 'once Caddy reaches it, SIPGES is ready' said 'SIPGES is ready.'

fresh
echo sha256:old >"$FAKE/images/sipges-local_current"
run install
check 'an install from before ready keeps the version that was answering' test "$(cat "$FAKE/images/sipges-local_previous")" = sha256:old

fresh
echo sha256:old >"$FAKE/images/sipges-local_current"
touch "$FAKE/not-ready"
run install || true
check 'but not a version that never answered' test ! -f "$FAKE/images/sipges-local_previous"

fresh
echo sha256:old >"$FAKE/images/sipges-local_current"
echo 'SIPGES_IMAGE_TAG=previous' >>"$SIPGES_ENV_FILE"
run build
check 'nor current while the old version is the one answering' test ! -f "$FAKE/images/sipges-local_previous"

fresh
touch "$FAKE/same-build"
run install
run install
check 'a rebuild of the same code keeps the way back' test ! -f "$FAKE/images/sipges-local_previous"

fresh
run install
marked=$(image_id ready)
touch "$FAKE/not-ready"
run install || true
command rm "$FAKE/not-ready"
echo 'SIPGES_IMAGE_TAG=previous' >>"$SIPGES_ENV_FILE"
run start
check 'running the old version does not vouch for the new one' test "$(image_id ready)" = "$marked"

fresh
run install
marked=$(image_id ready)
echo sha256:drill >"$FAKE/images/sipges-local_current"
SIPGES_PROJECT=sipges-drill SIPGES_SKIP_BUILD=1 run install
check 'a drill leaves the marks of a real install alone' test "$(image_id ready)" = "$marked"

# --- one API or two

# The calls start and update make with one API, with W for the work folder; the second readiness
# check (through Caddy) is the only change since replicas exist.
one_api_start='compose --env-file W/env -p sipges -f compose.yaml config -q
compose --env-file W/env -p sipges -f compose.yaml up -d db api caddy backup
compose --env-file W/env -p sipges -f compose.yaml exec -T caddy wget -qO- --header Host: localhost http://api:8080/health/ready
compose --env-file W/env -p sipges -f compose.yaml exec -T caddy wget -qO- --no-check-certificate --header Host: localhost https://127.0.0.1/health/ready
tag sipges-local:current sipges-local:ready'
one_api_update="compose version
info
compose --env-file W/env -p sipges -f compose.yaml config -q
compose --env-file W/env -p sipges -f compose.yaml exec -T backup bash /ops/backup.sh
build -f ../../apps/api-go/Dockerfile -t sipges-api-go:local ../..
build -f Dockerfile -t sipges-local:new ../..
image inspect -f {{.Id}} sipges-local:current
image inspect -f {{.Id}} sipges-local:ready
image inspect -f {{.Id}} sipges-local:new
tag sipges-local:current sipges-local:previous
tag sipges-local:new sipges-local:current
image inspect sipges-import:current
$one_api_start"
# The calls of a command, minus the read-only look for a second API left behind.
calls_of() { grep -v '^ps ' "$FAKE/calls" | sed "s#$work#W#g"; }
line_of() { grep -nF -- "$1" "$FAKE/calls" | head -n 1 | cut -d: -f1; }
before() { [[ -n $(line_of "$1") && -n $(line_of "$2") ]] && (($(line_of "$1") < $(line_of "$2"))); }
no_call() { test -z "$(grep -F -- "$1" "$FAKE/calls" 2>/dev/null || true)"; }
two_apis() {
  fresh
  echo 'SIPGES_API_REPLICAS=2' >>"$SIPGES_ENV_FILE"
  echo api-container >"$FAKE/api-container"
}

for setting in '' 'SIPGES_API_REPLICAS=1'; do
  fresh
  [[ -z $setting ]] || echo "$setting" >>"$SIPGES_ENV_FILE"
  label=${setting:-no SIPGES_API_REPLICAS}
  run install
  : >"$FAKE/calls"
  run start
  check "with $label, start makes the same calls as before" test "$(calls_of)" = "$one_api_start"
  check "with $label, start only looks for a second API, read-only" \
    test "$(grep '^ps ' "$FAKE/calls")" = 'ps -aq --filter label=com.docker.compose.project=sipges --filter label=com.docker.compose.service=api-2'
  : >"$FAKE/calls"
  run update
  check "with $label, update makes the same calls as before" test "$(calls_of)" = "$one_api_update"
  check "with $label, Caddy keeps its one upstream" test -z "$(grep -v '^unset$' "$FAKE/upstreams" || true)"
done

fresh
run install
echo stale-api-2 >"$FAKE/stale-api-2"
: >"$FAKE/calls"
run start
check 'back to one API, the second one left behind is removed' called 'rm -f stale-api-2'

two_apis
run install
: >"$FAKE/calls"
: >"$FAKE/upstreams"
run start
check 'with two APIs, start says it is ready' said 'SIPGES is ready'
check 'every compose call enables the second API' \
  test -z "$(grep '^compose ' "$FAKE/calls" | grep -vF -- '-f compose.yaml --profile replica ' || true)"
check 'Caddy gets both upstreams' test "$(sort -u "$FAKE/upstreams")" = 'api:8080 api-2:8080'
check 'the migrations run first, on their own' before 'run --rm migrate' 'up -d --no-deps api'
check 'then the first API, alone' before 'up -d --no-deps api' 'ps -q api'
check 'which must be healthy before the second one restarts' before '-f {{.State.Health.Status}}' 'up -d --no-deps api-2'
check 'then the second API is waited for too' \
  test "$(grep -n '^inspect' "$FAKE/calls" | tail -n 1 | cut -d: -f1)" -gt "$(line_of 'up -d --no-deps api-2')"
check 'and only then Caddy and the backups' before 'up -d --no-deps api-2' 'up -d --no-deps caddy backup'
check 'nothing restarts both APIs at once' no_call 'up -d db api caddy backup'
check 'and the version that answered is marked' called 'tag sipges-local:current sipges-local:ready'

two_apis
run install
: >"$FAKE/calls"
run update
check 'with two APIs, update backs up first' before 'backup.sh' 'build -f Dockerfile'
check 'and rolls the APIs one at a time' before 'up -d --no-deps api' 'up -d --no-deps api-2'

two_apis
run install
echo starting >"$FAKE/health"
: >"$FAKE/calls"
if run start; then fail 'a first API that never gets healthy stops the start'; else ok 'a first API that never gets healthy stops the start'; fi
check 'and the second one keeps serving the version it had' no_call 'up -d --no-deps api-2'
check 'and it says so' said 'the second API still serves'

two_apis
run install
touch "$FAKE/migrate-fails"
: >"$FAKE/calls"
if run start; then fail 'failed migrations stop the start'; else ok 'failed migrations stop the start'; fi
check 'before any API restarts' no_call 'up -d --no-deps'

two_apis
run install
mkdir -p "$work/backups/20261106T000000Z"
: >"$FAKE/calls"
run restore 20261106T000000Z --yes
check 'a restore stops both APIs' called 'stop api api-2 caddy backup'

for value in 3 0 two; do
  fresh
  echo "SIPGES_API_REPLICAS=$value" >>"$SIPGES_ENV_FILE"
  if run start; then fail "SIPGES_API_REPLICAS=$value is refused"; else ok "SIPGES_API_REPLICAS=$value is refused"; fi
  check 'with a message naming the allowed values' said 'SIPGES_API_REPLICAS must be 1 or 2'
  check 'and nothing started' no_call ' up '
  run update || true
  check 'update refuses it before backing up or building' never_built
  check 'or backing up' no_call backup.sh
done

command rm -rf "$root"
if ((failures > 0)); then
  printf '%d failed\n' "$failures"
  exit 1
fi
printf 'all passed\n'
