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
    # One failing call, as when the Docker daemon hiccups mid-update.
    if [[ -f $FAKE/ps-fails-once ]]; then
      command rm -f "$FAKE/ps-fails-once"
      exit 1
    fi
    if [[ $* == *api* ]]; then cat "$FAKE/api-container" 2>/dev/null; else echo db-container; fi
    ;;
  exec)
    [[ $* != *caddy* || ! -f $FAKE/not-ready ]] || exit 1
    [[ $* != *caddy* ]] || echo '{"status":"ready"}'
    ;;
  run)
    [[ $* != *migrate* || ! -f $FAKE/migrate-fails ]] || exit 1
    [[ $* != *' offsite '* || ! -f $FAKE/offsite-fails ]] || exit 1
    # An off-site fetch lands the backup where ./sipges restore looks for it.
    if [[ $* == *' offsite fetch '* ]]; then mkdir -p "$(sed -n 's/^SIPGES_BACKUP_DIR=//p' "$SIPGES_ENV_FILE")/${*: -1}"; fi
    echo "gid=${SIPGES_HOST_GID:-unset}" >"$FAKE/run-env"
    stat -c '%a %g' "$SIPGES_IMPORT_REPORTS" >"$FAKE/reports-during-run"
    for arg in "$@"; do
      if [[ ${previous:-} == --report ]]; then echo '{}' >"$SIPGES_IMPORT_REPORTS/${arg#/reports/}"; fi
      previous=$arg
    done
    ;;
  esac
  ;;
info)
  # The machine Docker runs on, as `docker info --format '{{.NCPU}} {{.MemTotal}}'` answers.
  [[ $* != *--format* ]] || cat "$FAKE/machine" 2>/dev/null
  ;;
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
# shellcheck disable=SC2016 # the fake expands these when it runs
printf '#!/usr/bin/env bash\necho "$*" >>"$FAKE/sleeps"\n' >"$root/sleep"
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
said_not() { ! grep -qF -- "$1" "$work/out"; }
called() { grep -qF -- "$1" "$FAKE/calls"; }
said_not_refused() { called ' up -d'; }
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

# Caddy skips an API whose health check failed while it booted until its next check (every 2 s), so
# start waits one cycle after the API answers before calling SIPGES ready.
: >"$FAKE/sleeps"
run start
check 'once the API answers, start waits for the next Caddy check' grep -qx 3 "$FAKE/sleeps"
check 'and only then says SIPGES is ready' said 'SIPGES is ready.'

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

# The calls start and update made before replicas existed, with W for the work folder.
one_api_start='compose --env-file W/env -p sipges -f compose.yaml config -q
info --format {{.NCPU}} {{.MemTotal}}
compose --env-file W/env -p sipges -f compose.yaml up -d db api caddy backup
compose --env-file W/env -p sipges -f compose.yaml exec -T caddy wget -qO- --header Host: localhost http://api:8080/health/ready
tag sipges-local:current sipges-local:ready'
one_api_update="compose version
info
compose --env-file W/env -p sipges -f compose.yaml config -q
compose --env-file W/env -p sipges -f compose.yaml exec -T backup bash /ops/backup.sh
build -f ../../apps/api-go/Dockerfile -t sipges-api-go:local ../..
build -f Dockerfile --label org.opencontainers.image.revision=unknown -t sipges-local:new ../..
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

# A refusal inside $(…) only ends the subshell: the caller must stop too, and say it once.
fresh
run install
echo 'SIPGES_API_REPLICAS=3' >>"$SIPGES_ENV_FILE"
mkdir -p "$work/backups/20261106T000000Z"
: >"$FAKE/calls"
if run restore 20261106T000000Z --yes; then fail 'a restore refuses SIPGES_API_REPLICAS=3'; else ok 'a restore refuses SIPGES_API_REPLICAS=3'; fi
check 'and says it once' test "$(grep -cF 'SIPGES_API_REPLICAS must be 1 or 2' "$work/out")" = 1
check 'and stops nothing' no_call ' stop'

# A passing Docker error while waiting for a healthy service is polled through, not fatal.
two_apis
run install
touch "$FAKE/ps-fails-once"
if run start; then ok 'a rolling start survives one failing compose ps while it waits'; else fail 'a rolling start survives one failing compose ps while it waits'; fi


# --- sizing to the machine Docker runs on (local-qa-findings T16)

GIB=$((1024 * 1024 * 1024))
sized() { # cpus gib -> runs install on that machine
  fresh
  printf '%s %s\n' "$1" "$(($2 * GIB))" >"$FAKE/machine"
  run install
}
env_is() { [[ $(sed -n "s/^$1=//p" "$SIPGES_ENV_FILE" | tail -n 1) == "$2" ]]; }

sized 2 4
check 'a small machine keeps the 1 GiB API limit' env_is SIPGES_API_MEMORY 1g
check 'and Go keeps its 800 MiB target, as the image sets it' env_is SIPGES_API_GOMEMLIMIT 800MiB
check 'and the pool pgx would choose, 4' env_is SIPGES_DB_POOL_MAX 4
sized 8 7
check 'below 8 GiB the API limit stays 1 GiB' env_is SIPGES_API_MEMORY 1g
check 'the pool follows the CPUs, as pgx does' env_is SIPGES_DB_POOL_MAX 8
sized 16 32
check 'a large machine gives the API a quarter of its memory, up to 4 GiB' env_is SIPGES_API_MEMORY 4g
check 'and Go may use 800 MiB of each GiB, or the larger limit would sit unused' env_is SIPGES_API_GOMEMLIMIT 3200MiB
check 'and a pool of one connection per CPU' env_is SIPGES_DB_POOL_MAX 16
check 'install says what it chose' said 'Sized for 16 CPUs and 32 GiB'
sized 64 12
check '12 GiB gives 3 GiB' env_is SIPGES_API_MEMORY 3g
check 'the pool stops at 40, so two APIs stay under PostgreSQL'"'"'s 100 connections' env_is SIPGES_DB_POOL_MAX 40

sized 4 8
check '8 GiB is the first size above 1 GiB' env_is SIPGES_API_MEMORY 2g

# PostgreSQL gets its own limit and settings from it (world-class-local T1).
sized 2 4
check 'a small machine gives PostgreSQL 1 GiB' env_is SIPGES_DB_MEMORY 1g
check 'and a quarter of it as shared_buffers' env_is SIPGES_DB_SHARED_BUFFERS 256MB
check 'and half of it as the cache estimate' env_is SIPGES_DB_EFFECTIVE_CACHE_SIZE 512MB
check 'and work_mem from what is left for its 6 connections, each running a hash step at twice it' env_is SIPGES_DB_WORK_MEM 41MB
check 'and maintenance_work_mem of a sixteenth' env_is SIPGES_DB_MAINTENANCE_WORK_MEM 64MB
sized 16 32
check 'a large machine gives PostgreSQL up to 4 GiB' env_is SIPGES_DB_MEMORY 4g
check 'with 1 GiB of shared_buffers' env_is SIPGES_DB_SHARED_BUFFERS 1024MB
check 'a 2 GiB cache estimate' env_is SIPGES_DB_EFFECTIVE_CACHE_SIZE 2048MB
check 'and 59 MB of work_mem for 18 connections' env_is SIPGES_DB_WORK_MEM 59MB

# Two APIs share the API budget instead of taking it twice (world-class-local T1).
two_apis
printf '8 %s\n' "$((16 * GIB))" >"$FAKE/machine"
run install
check 'two APIs on 16 GiB get 2 GiB each, not 4 each (half the machine)' env_is SIPGES_API_MEMORY 2g
check 'and Go follows the halved limit' env_is SIPGES_API_GOMEMLIMIT 1600MiB
two_apis
printf '4 %s\n' "$((7 * GIB))" >"$FAKE/machine"
run install
check 'two APIs on 7 GiB keep the 1 GiB floor each' env_is SIPGES_API_MEMORY 1g
two_apis
printf '12 %s\n' "$((7 * GIB))" >"$FAKE/machine"
run install
check 'on the owner'"'"'s laptop, two APIs of 12 connections leave 6 MB of work_mem, inside 1 GiB' env_is SIPGES_DB_WORK_MEM 6MB

# A hand-edited .env: no final newline, and a line whose name only starts like a sized one.
fresh
printf 'SIPGES_API_MEMORY_NOTE=keep\nSIPGES_TIMEZONE=America/Lima' >>"$SIPGES_ENV_FILE"
printf '16 %s\n' "$((32 * GIB))" >"$FAKE/machine"
run install
check 'the last line of an .env without a final newline survives' env_is SIPGES_TIMEZONE America/Lima
check 'a line that only starts like a sized one survives' env_is SIPGES_API_MEMORY_NOTE keep
check 'and the sizing is written after it' env_is SIPGES_API_MEMORY 4g

# A start that its checks stop leaves the .env as it was.
fresh
printf '16 %s\n' "$((32 * GIB))" >"$FAKE/machine"
printf 'SIPGES_BACKUP_HOUR=25\n' >>"$SIPGES_ENV_FILE"
cp "$SIPGES_ENV_FILE" "$work/env.before"
run start || true
check 'a start its checks refuse does not rewrite the .env' cmp -s "$SIPGES_ENV_FILE" "$work/env.before"

# A bigger machine later: update sizes again and keeps one line of each.
sized 4 8
printf '16 %s\n' "$((32 * GIB))" >"$FAKE/machine"
run update || true
check 'update follows a bigger machine' env_is SIPGES_API_MEMORY 4g
check 'and keeps one line of each' test "$(grep -c '^SIPGES_API_MEMORY=' "$SIPGES_ENV_FILE")" = 1

# The operator's own values stay when the .env says so.
fresh
printf '16 %s\n' "$((32 * GIB))" >"$FAKE/machine"
printf 'SIPGES_SIZING=manual\nSIPGES_API_MEMORY=6g\nSIPGES_DB_POOL_MAX=12\n' >>"$SIPGES_ENV_FILE"
run install
check 'SIPGES_SIZING=manual keeps the memory the operator set' env_is SIPGES_API_MEMORY 6g
check 'and the pool' env_is SIPGES_DB_POOL_MAX 12

# Docker that cannot say: nothing is written, and the install goes on with the defaults.
fresh
run install
check 'without the machine'"'"'s size the install still runs' said 'Open https://'
check 'and writes no sizing' test -z "$(grep '^SIPGES_API_MEMORY=' "$SIPGES_ENV_FILE" || true)"


# --- a copy of the backups on a second disk (local-qa-findings T15)

fresh
mkdir -p "$work/second"
run copy-backups-to "$work/second" || true
check 'copy-backups-to marks the folder as the copy' test -f "$work/second/.sipges-backup-copy"
check 'and writes it to the .env' env_is SIPGES_BACKUP_COPY_DIR "$work/second"
check 'and says how to apply it' said './sipges start'
mkdir -p "$work/other"
run copy-backups-to "$work/other" || true
check 'a new folder replaces the old one, one line only' test "$(grep -c '^SIPGES_BACKUP_COPY_DIR=' "$SIPGES_ENV_FILE")" = 1
check 'with the new path' env_is SIPGES_BACKUP_COPY_DIR "$work/other"

fresh
if run copy-backups-to "$work/nowhere"; then fail 'a missing folder is refused'; else ok 'a missing folder is refused'; fi
check 'and nothing is written' test -z "$(grep '^SIPGES_BACKUP_COPY_DIR=' "$SIPGES_ENV_FILE" || true)"
if run copy-backups-to "$work/backups"; then fail 'the backup folder itself is refused'; else ok 'the backup folder itself is refused'; fi
check 'with the reason' said 'another disk'
if run copy-backups-to; then fail 'no folder is refused'; else ok 'no folder is refused'; fi

# A disk that is not plugged in: the start says so, and nothing stops.
fresh
mkdir -p "$work/second"
run copy-backups-to "$work/second" || true
command rm -f "$work/second/.sipges-backup-copy"
run start || true
check 'start warns when the copy folder lost its mark' said 'is the disk plugged in'
check 'and still starts' said_not_refused

# status shows a failed copy.
fresh
printf '2026-11-19T07:00:00Z the copy folder is not marked\n' >"$work/backups/.last-copy-failure"
run status || true
check 'status shows the failed copy' said 'the copy to the second disk failed at 2026-11-19T07:00:00Z'


# The copy step itself (ops/copy.sh), on folders of this test instead of the container's.
copy_step() { # backups folder, copy folder, name
  SIPGES_BACKUPS_PATH=$1 SIPGES_COPY_PATH=$2 SIPGES_BACKUP_COPY=/media/disk SIPGES_BACKUP_KEEP=2 SIPGES_BACKUP_KEEP_WEEKLY=0 SIPGES_BACKUP_KEEP_MONTHLY=0 \
    bash "$(dirname "$script")/ops/copy.sh" "$3" >"$work/out" 2>&1
}
a_backup() { # folder name
  mkdir -p "$1/$2"
  echo "$2" >"$1/$2/db.dump.gpg"
  (cd "$1/$2" && sha256sum db.dump.gpg >SHA256SUMS)
}
fresh
copies=$work/disk
mkdir -p "$copies"
touch "$copies/.sipges-backup-copy"
mkdir "$copies/2025 photos Z" "$copies/20250101T000000Z-notes"
for stamp in 20261117T070000Z 20261118T070000Z 20261119T070000Z; do
  a_backup "$work/backups" "$stamp"
  copy_step "$work/backups" "$copies" "$stamp"
done
check 'each backup is copied and checked' test -f "$copies/20261119T070000Z/SHA256SUMS"
check 'the copy keeps SIPGES_BACKUP_KEEP of them' test ! -e "$copies/20261117T070000Z"
check 'and touches no folder that is not a backup' test -d "$copies/2025 photos Z"
check 'not even one that starts like one' test -d "$copies/20250101T000000Z-notes"

# An old copy that cannot be removed (a disk gone read-only): the copy step still ends with 0.
fresh
copies=$work/disk
mkdir -p "$copies/20261101T070000Z/locked"
touch "$copies/.sipges-backup-copy" "$copies/20261101T070000Z/locked/file"
chmod a-w "$copies/20261101T070000Z/locked"
a_backup "$work/backups" 20261118T070000Z
a_backup "$work/backups" 20261119T070000Z
copy_step "$work/backups" "$copies" 20261118T070000Z
if copy_step "$work/backups" "$copies" 20261119T070000Z; then
  ok 'a copy whose old copies cannot be removed does not fail the backup'
else
  fail 'a copy whose old copies cannot be removed does not fail the backup'
fi
check 'and is recorded for status' grep -q 'could not remove older copies' "$work/backups/.last-copy-failure"
chmod u+w "$copies/20261101T070000Z/locked"

# A copy that does not match its checksums never counts.
fresh
copies=$work/disk
mkdir -p "$copies"
touch "$copies/.sipges-backup-copy"
a_backup "$work/backups" 20261119T070000Z
echo tampered >"$work/backups/20261119T070000Z/db.dump.gpg"
copy_step "$work/backups" "$copies" 20261119T070000Z
check 'a copy that does not match is not kept' test ! -e "$copies/20261119T070000Z"
check 'nor is its partial' test -z "$(find "$copies" -name '.partial-*')"
check 'and the failure is recorded' grep -q 'could not copy' "$work/backups/.last-copy-failure"

# Unmarked (the disk is not plugged in): nothing is written, and the way back is named.
fresh
mkdir -p "$work/empty"
a_backup "$work/backups" 20261119T070000Z
copy_step "$work/backups" "$work/empty" 20261119T070000Z
check 'an unmarked folder gets nothing' test -z "$(ls -A "$work/empty")"
check 'and the failure says to plug the disk in and start again' grep -q 'run ./sipges start' "$work/backups/.last-copy-failure"

# A copy turned off: the failure of an earlier one stops showing.
fresh
printf '2026-11-19T07:00:00Z old\n' >"$work/backups/.last-copy-failure"
a_backup "$work/backups" 20261119T070000Z
SIPGES_BACKUPS_PATH=$work/backups SIPGES_COPY_PATH=$work/none SIPGES_BACKUP_COPY='' \
  bash "$(dirname "$script")/ops/copy.sh" 20261119T070000Z >"$work/out" 2>&1
check 'with no copy set, an old copy failure is cleared' test ! -e "$work/backups/.last-copy-failure"

# A start with a copy folder gives the backup service a fresh mount; without one it does not.
fresh
mkdir -p "$work/second"
run copy-backups-to "$work/second" || true
check 'a folder on the same disk as the backups is pointed out' said 'same disk as the backups'
: >"$FAKE/calls"
run install || true
check 'start with a copy folder recreates the backup service, for a disk plugged in since' called 'up -d --no-deps --force-recreate backup'
fresh
: >"$FAKE/calls"
run install || true
check 'without one it does not' no_call 'force-recreate'

# --- calendar retention, catch-up and stale warning (world-class-local T2)

retain() { # daily weekly monthly < names -> names to remove
  bash "$(dirname "$script")/ops/retain.sh" "$@"
}
# Nightly backups for 400 days up to 2026-11-21, plus a second one on the last day (an update).
names=$(for i in $(seq 0 399); do date -u -d "2026-11-21 -$i days" +%Y%m%dT070000Z; done; echo 20261121T150000Z)
removed=$(printf '%s\n' "$names" | retain 14 8 12)
kept=$(printf '%s\n' "$names" | grep -vxF -f <(printf '%s\n' "$removed"))
check 'retention keeps the 14 newest, as before' test -z "$(printf '%s\n' "$names" | sort -r | head -n 14 | grep -vxF -f <(printf '%s\n' "$kept"))"
check 'both backups of the last day among them' grep -qx 20261121T070000Z <<<"$kept"
check 'an older night that is not its week'"'"'s newest goes' grep -qx 20261107T070000Z <<<"$removed"
check 'a backup about 6 weeks old survives as its week'"'"'s newest' grep -qx 20261011T070000Z <<<"$kept"
check 'one about 10 months old survives as its month'"'"'s newest' grep -qx 20260131T070000Z <<<"$kept"
check 'one 13 months old goes' grep -qx 20251031T070000Z <<<"$removed"
check 'at most 14 + 8 + 12 are kept' test "$(printf '%s\n' "$kept" | wc -l)" -le 34
check 'names that are not backups are never listed' test -z "$(printf 'notes\n2025 photos Z\n' | retain 14 8 12)"
check 'a name with an impossible date is skipped, not a failure of the backup' test "$(printf '20261399T070000Z\n20261121T070000Z\n' | retain 1 0 0; echo "exit=$?")" = 'exit=0'
check 'the wait between checks is at most an hour, so a laptop that slept through 02:00 catches up within an hour of waking' \
  test "$(bash "$(dirname "$script")/ops/schedule.sh" --nap 2)" -le 3600

due() { # backups folder -> prints yes or no
  SIPGES_BACKUPS_PATH=$1 bash "$(dirname "$script")/ops/schedule.sh" --due
}
fresh
check 'with no backup yet, one is due at start' test "$(due "$work/backups")" = yes
mkdir "$work/backups/20261120T070000Z"
touch -d '25 hours ago' "$work/backups/20261120T070000Z"
check 'a laptop that slept through 02:00 backs up at start' test "$(due "$work/backups")" = yes
mkdir "$work/backups/20261121T070000Z"
check 'a backup from the last day makes none due' test "$(due "$work/backups")" = no

fresh
mkdir "$work/backups/20261119T070000Z"
touch -d '30 hours ago' "$work/backups/20261119T070000Z"
run status || true
check 'status warns when the newest backup is over 26 hours old' said 'WARNING: the newest backup is more than 26 hours old'
fresh
mkdir "$work/backups/20261121T070000Z"
run status || true
check 'and not when it is recent' said_not 'more than 26 hours old'

# The backup just written counts among the SIPGES_BACKUP_KEEP newest, even when older ones carry
# names from a clock ahead (the drill's 2099 folders): as before, it plus KEEP-1 others remain.
fresh
copies=$work/disk
mkdir -p "$copies/20991231T235959Z" "$copies/20991231T235958Z" "$copies/20991231T235957Z"
touch "$copies/.sipges-backup-copy"
a_backup "$work/backups" 20261121T070000Z
copy_step "$work/backups" "$copies" 20261121T070000Z
check 'the new copy stays when a clock ahead named older ones later' test -d "$copies/20261121T070000Z"
check 'and with it SIPGES_BACKUP_KEEP of them remain, not one more' test "$(find "$copies" -mindepth 1 -maxdepth 1 -type d -name '20*Z' | wc -l)" -eq 2

# --- a warning until backups have a copy on another disk (world-class-local T3)

fresh
mkdir "$work/backups/20261121T070000Z"
run status || true
check 'status warns while the backups live only on this disk' said 'WARNING: the backups are only on this computer'
check 'and says how to fix it' said './sipges copy-backups-to'
fresh
mkdir -p "$work/backups/20261121T070000Z" "$work/disk"
printf 'SIPGES_BACKUP_COPY_DIR=%s\n' "$work/disk" >>"$SIPGES_ENV_FILE"
run status || true
check 'with a copy folder set it does not' said_not 'the backups are only on this computer'

# --- the recovery kit for the backup secrets (world-class-local T4)

fresh
printf 'SIPGES_DATA_KEY=synthetic-data-key-0000\nSIPGES_BACKUP_PASSPHRASE=synthetic-passphrase-a1b2\n' >>"$SIPGES_ENV_FILE"
run install
pass=$(sed -n 's/^SIPGES_BACKUP_PASSPHRASE=//p' "$SIPGES_ENV_FILE")
key=$(sed -n 's/^SIPGES_DATA_KEY=//p' "$SIPGES_ENV_FILE")
run status || true
check 'status warns until a recovery kit is confirmed' said 'WARNING: no recovery kit confirmed'
if run recovery-kit "$work/kit.txt" <<<"zzzz"; then fail 'a wrong confirmation is refused'; else ok 'a wrong confirmation is refused'; fi
check 'and records nothing' test ! -e "$work/.sipges-recovery-kit"
check 'the sheet holds the backup passphrase' grep -qF "$pass" "$work/kit.txt"
check 'and the data key' grep -qF "$key" "$work/kit.txt"
check 'and how to restore on another computer' grep -qF './sipges restore' "$work/kit.txt"
check 'only its owner may read it' test "$(stat -c %a "$work/kit.txt")" = 600
run recovery-kit "$work/kit.txt" <<<"${pass: -4}"
check 'the last 4 characters confirm it' test -s "$work/.sipges-recovery-kit"
check 'what is recorded is not the passphrase' bash -c "! grep -qF '$pass' '$work/.sipges-recovery-kit'"
run status || true
check 'then status no longer warns' said_not 'no recovery kit confirmed'
sed -i "s/^SIPGES_BACKUP_PASSPHRASE=.*/SIPGES_BACKUP_PASSPHRASE=changed${pass:7}/" "$SIPGES_ENV_FILE"
run status || true
check 'a changed passphrase needs a new kit' said 'WARNING: no recovery kit confirmed'

# An empty answer never confirms, not even for a passphrase shorter than 4 characters.
fresh
printf 'SIPGES_DATA_KEY=synthetic-data-key-0000\nSIPGES_BACKUP_PASSPHRASE=ab\n' >>"$SIPGES_ENV_FILE"
if run recovery-kit "$work/kit.txt" <<<""; then fail 'an empty answer does not confirm a short passphrase'; else ok 'an empty answer does not confirm a short passphrase'; fi
check 'and nothing is recorded' test ! -e "$work/.sipges-recovery-kit"

# --- which build is running (world-class-local T6)

fresh
run install
check 'the image is labelled with the commit it was built from (unknown without git)' called 'build -f Dockerfile --label org.opencontainers.image.revision=unknown -t sipges-local:new'
run status || true
check 'status says which build is running' said 'Build: '

# --- rollback to the previous build and a free-disk guard (world-class-local T6)

# A stand-in df: the free space a test sets in $FAKE/df-free (1K blocks), else the real one.
cat >"$root/df" <<'DF'
#!/usr/bin/env bash
if [[ -f $FAKE/df-free ]]; then
  printf 'Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/x 100 0 %s 1%% /\n' "$(cat "$FAKE/df-free")"
else
  command -p df "$@"
fi
DF
chmod +x "$root/df"

fresh
run install
if run rollback; then fail 'rollback with no previous build is refused'; else ok 'rollback with no previous build is refused'; fi
check 'and says why' said 'no previous version to go back to'
echo 'sha256:old' >"$FAKE/images/sipges-local_previous"
: >"$FAKE/calls"
run rollback
check 'rollback puts the previous build back' test "$(cat "$FAKE/images/sipges-local_current")" = 'sha256:old'
check 'and starts it' called ' up -d'
check 'and does not touch the data: no restore, no backup' test -z "$(grep -E 'restore|backup.sh' "$FAKE/calls" || true)"
check 'and says how to return to the latest' said './sipges update'

fresh
run install
echo 1048576 >"$FAKE/df-free"
: >"$FAKE/calls"
if run update; then fail 'update with 1 GB free is refused'; else ok 'update with 1 GB free is refused'; fi
check 'before it backs up or builds' test -z "$(grep -E 'backup.sh|^build' "$FAKE/calls" || true)"
check 'and says how much is free' said 'only 1 GB free'
if run backup; then fail 'a backup with 1 GB free is refused'; else ok 'a backup with 1 GB free is refused'; fi
echo 20971520 >"$FAKE/df-free"
run backup
check 'with 20 GB free the backup runs' called 'backup.sh'
rm -f "$FAKE/df-free"

# --- an off-site copy of the sealed backups (world-class-local T13)

offsite_env() { printf 'SIPGES_RCLONE_DIR=%s/rclone\n' "$work" >>"$SIPGES_ENV_FILE"; }

fresh
offsite_env
if run offsite-to; then fail 'offsite-to with no remote is refused'; else ok 'offsite-to with no remote is refused'; fi
if run offsite-to ':sftp,host=nas,pass=secret:sipges'; then fail 'a connection string is refused'; else ok 'a connection string is refused'; fi
check 'because it would put a password in the .env' said 'a remote named in'
if run offsite-to /media/disk/sipges; then fail 'a local folder is refused'; else ok 'a local folder is refused'; fi
check 'and copy-backups-to is named for it' said 'copy-backups-to'
check 'nothing refused is written' test -z "$(grep '^SIPGES_BACKUP_OFFSITE=' "$SIPGES_ENV_FILE" || true)"

fresh
offsite_env
run install
touch "$FAKE/offsite-fails"
if run offsite-to nas:sipges; then fail 'a remote that cannot be reached is refused'; else ok 'a remote that cannot be reached is refused'; fi
check 'and is not written' test -z "$(grep '^SIPGES_BACKUP_OFFSITE=' "$SIPGES_ENV_FILE" || true)"
check 'and the way to set it up is named' said './sipges offsite-config'
command rm -f "$FAKE/offsite-fails"
: >"$FAKE/calls"
run offsite-to nas:sipges
check 'offsite-to tries the remote before writing it' called 'run --rm --no-deps -e SIPGES_BACKUP_OFFSITE=nas:sipges offsite probe'
check 'then writes it to the .env' env_is SIPGES_BACKUP_OFFSITE nas:sipges
check 'and starts the off-site service' called 'up -d offsite'
check 'the rclone settings file exists for the mount' test -f "$work/rclone/rclone.conf"
check 'and only its owner may read it' test "$(stat -c %a "$work/rclone/rclone.conf")" = 600
check 'nor open its folder' test "$(stat -c %a "$work/rclone")" = 700
run offsite-to nas:other
check 'a new remote replaces the old one, one line only' test "$(grep -c '^SIPGES_BACKUP_OFFSITE=' "$SIPGES_ENV_FILE")" = 1
: >"$FAKE/calls"
run start
check 'start with a remote starts the off-site service' called 'up -d offsite'
run offsite-to --off
check 'offsite-to --off removes the remote' test -z "$(grep '^SIPGES_BACKUP_OFFSITE=' "$SIPGES_ENV_FILE" || true)"
check 'and stops the service' called 'rm -sf offsite'
: >"$FAKE/calls"
run start
check 'start without a remote leaves the off-site service off' bash -c "! grep -qF 'up -d offsite' '$FAKE/calls'"

fresh
offsite_env
: >"$FAKE/calls"
run offsite-config < /dev/null || true
check 'offsite-config runs rclone config in the service' called 'run --rm --no-deps --entrypoint rclone offsite config'
check 'on a settings file only its owner may read' test "$(stat -c %a "$work/rclone/rclone.conf")" = 600
check 'and says how to pin an SFTP server key' said 'known_hosts_file'

# status: where the backups go, and when the push fails or stops.
fresh
offsite_env
printf 'SIPGES_BACKUP_OFFSITE=nas:sipges\n' >>"$SIPGES_ENV_FILE"
printf '2026-11-22T07:00:00Z 20261122T070000Z\n' >"$work/backups/.last-offsite"
run status || true
check 'status names the off-site remote and its newest backup' said 'Backups pushed off-site to nas:sipges (newest 20261122T070000Z)'
check 'an off-site copy is a copy off this computer' said_not 'the backups are only on this computer'
touch -d '-30 hours' "$work/backups/.last-offsite"
run status || true
check 'status warns when no push succeeded for 26 hours' said 'WARNING: no backup reached nas:sipges in the last 26 hours'
printf '2026-11-22T08:00:00Z could not push 20261122T070000Z to nas:sipges\n' >"$work/backups/.last-offsite-failure"
run status || true
check 'status shows a failed push' said 'WARNING: the off-site push failed at 2026-11-22T08:00:00Z: could not push'
check 'every call names the off-site profile while a remote is set' called '--profile offsite'

# restore and backups read from the remote.
fresh
offsite_env
if run restore 20261120T070000Z --yes; then fail 'restoring a backup that is nowhere is refused'; else ok 'restoring a backup that is nowhere is refused'; fi
check 'without a remote it says there is no such backup' said 'no backup named 20261120T070000Z'
if run backups --offsite; then fail 'backups --offsite without a remote is refused'; else ok 'backups --offsite without a remote is refused'; fi
printf 'SIPGES_BACKUP_OFFSITE=nas:sipges\n' >>"$SIPGES_ENV_FILE"
: >"$FAKE/calls"
run backups --offsite
check 'backups --offsite lists the remote' called 'offsite list'
: >"$FAKE/calls"
run restore 20261120T070000Z --yes || true
check 'a backup missing here is fetched from the remote' called 'offsite fetch 20261120T070000Z'
check 'and then restored' called 'run --rm restore 20261120T070000Z'
check 'saying where it came from' said 'Fetching 20261120T070000Z from nas:sipges'
touch "$FAKE/offsite-fails"
command rm -rf "$work/backups/20261121T070000Z"
: >"$FAKE/calls"
if run restore 20261121T070000Z --yes; then fail 'a fetch that fails stops the restore'; else ok 'a fetch that fails stops the restore'; fi
check 'before anything is stopped' bash -c "! grep -qE ' stop |run --rm restore' '$FAKE/calls'"
command rm -f "$FAKE/offsite-fails"

# The kit names the remote: on another computer the backups are there.
fresh
offsite_env
printf 'SIPGES_DATA_KEY=synthetic-data-key-0000\nSIPGES_BACKUP_PASSPHRASE=synthetic-passphrase-a1b2\nSIPGES_BACKUP_OFFSITE=nas:sipges\n' >>"$SIPGES_ENV_FILE"
run recovery-kit "$work/kit.txt" <<<"zzzz" || true
check 'the recovery kit names the off-site remote' grep -qF 'Off-site copy:   nas:sipges' "$work/kit.txt"
check 'and says to keep the rclone settings with the .env' grep -qF 'rclone folder' "$work/kit.txt"

# The push itself (ops/offsite.sh), against a stand-in rclone whose fake: remote is a folder.
cat >"$root/rclone" <<'RCLONE'
#!/usr/bin/env bash
# Answers like rclone for the calls ops/offsite.sh makes; fake:<path> is $RCLONE_ROOT/<path>.
printf '%s\n' "$*" >>"$RCLONE_ROOT/.calls"
[[ ! -f $RCLONE_ROOT/.down ]] || exit 1
at() { if [[ $1 == fake:* ]]; then printf '%s/%s' "$RCLONE_ROOT" "${1#fake:}"; else printf '%s' "$1"; fi; }
cmd=$1
shift
exclude= args=()
for a in "$@"; do
  case $a in
  --exclude=*) exclude=${a#--exclude=/} ;;
  -*) ;;
  *) args+=("$a") ;;
  esac
done
case $cmd in
mkdir) mkdir -p "$(at "${args[0]}")" ;;
lsf) [[ -d $(at "${args[0]}") ]] || exit 3; (cd "$(at "${args[0]}")" && find . -mindepth 1 -maxdepth 2 -type f -printf '%P\n' | sort) ;;
copy)
  src=$(at "${args[0]}") dst=$(at "${args[1]}")
  [[ -d $src ]] || exit 3
  mkdir -p "$dst"
  for f in "$src"/*; do
    [[ $(basename "$f") != "$exclude" ]] || continue
    if [[ -f $RCLONE_ROOT/.copy-fails && $(basename "$f") == uploads.tar.gpg ]]; then exit 1; fi
    cp "$f" "$dst/"
  done
  ;;
check)
  src=$(at "${args[0]}") dst=$(at "${args[1]}")
  for f in "$src"/*; do
    [[ $(basename "$f") != "$exclude" ]] || continue
    cmp -s "$f" "$dst/$(basename "$f")" || exit 1
  done
  ;;
copyto) mkdir -p "$(dirname "$(at "${args[1]}")")" && cp "$(at "${args[0]}")" "$(at "${args[1]}")" ;;
purge) rm -rf -- "$(at "${args[0]}")" ;;
rcat) mkdir -p "$(dirname "$(at "${args[0]}")")" && cat >"$(at "${args[0]}")" ;;
cat) cat "$(at "${args[0]}")" ;;
deletefile) rm -f -- "$(at "${args[0]}")" ;;
*) exit 2 ;;
esac
RCLONE
chmod +x "$root/rclone"

offsite_step() { # mode [name]
  PATH="$root:$PATH" RCLONE_ROOT=$work/remote SIPGES_BACKUPS_PATH=$work/backups SIPGES_BACKUP_OFFSITE=fake:sipges \
    SIPGES_BACKUP_KEEP=2 SIPGES_BACKUP_KEEP_WEEKLY=0 SIPGES_BACKUP_KEEP_MONTHLY=0 \
    bash "$(dirname "$script")/ops/offsite.sh" "$@" >"$work/out" 2>&1
}
sealed() { # name: a backup as backup.sh leaves it
  mkdir -p "$work/backups/$1"
  echo "dump $1" >"$work/backups/$1/db.dump.gpg"
  echo "files $1" >"$work/backups/$1/uploads.tar.gpg"
  (cd "$work/backups/$1" && sha256sum db.dump.gpg uploads.tar.gpg >SHA256SUMS)
}
remote=
fresh
remote=$work/remote/sipges
mkdir -p "$work/remote"
for stamp in 20261118T070000Z 20261119T070000Z 20261120T070000Z; do sealed "$stamp"; done
offsite_step push
check 'a first push sends only the newest backup' test -f "$remote/20261120T070000Z/SHA256SUMS"
check 'not every older one' test ! -e "$remote/20261119T070000Z"
check 'the checksums go up last, after the files are checked' \
  test "$(grep -nE '^(check|copyto)' "$work/remote/.calls" | head -n 1 | cut -d: -f2 | cut -d' ' -f1)" = check
check 'a push records the newest backup that reached the remote' grep -q ' 20261120T070000Z$' "$work/backups/.last-offsite"
sealed 20261121T070000Z
sealed 20261122T070000Z
mkdir -p "$remote/notes"
touch "$remote/notes/keep.txt"
offsite_step push
check 'a computer that was off pushes every backup it missed' test -f "$remote/20261121T070000Z/SHA256SUMS"
check 'up to the newest' test -f "$remote/20261122T070000Z/SHA256SUMS"
check 'the remote keeps SIPGES_BACKUP_KEEP of them' test ! -e "$remote/20261120T070000Z"
check 'and touches nothing that is not a backup' test -f "$remote/notes/keep.txt"
offsite_step list
check 'list names the backups on the remote' test "$(cat "$work/out")" = $'20261121T070000Z\n20261122T070000Z'

# A push cut short never counts, is recorded, and is finished on the next round.
fresh
remote=$work/remote/sipges
mkdir -p "$work/remote"
sealed 20261122T070000Z
touch "$work/remote/.copy-fails"
if offsite_step push; then fail 'a push that fails says so'; else ok 'a push that fails says so'; fi
check 'and leaves no checksums on the remote' test ! -e "$remote/20261122T070000Z/SHA256SUMS"
check 'so list does not show it' bash -c "PATH='$root:$PATH' RCLONE_ROOT='$work/remote' SIPGES_BACKUPS_PATH='$work/backups' SIPGES_BACKUP_OFFSITE=fake:sipges bash '$(dirname "$script")/ops/offsite.sh' list | grep -c . | grep -qx 0"
check 'and the failure is recorded for status' grep -q 'could not push 20261122T070000Z' "$work/backups/.last-offsite-failure"
command rm -f "$work/remote/.copy-fails"
offsite_step push
check 'the next round finishes it' test -f "$remote/20261122T070000Z/SHA256SUMS"
check 'and clears the failure' test ! -e "$work/backups/.last-offsite-failure"
# A half pushed backup that is gone here is removed from the remote.
mkdir -p "$remote/20261101T070000Z"
echo partial >"$remote/20261101T070000Z/db.dump.gpg"
offsite_step push
check 'a half pushed backup no longer here is removed' test ! -e "$remote/20261101T070000Z"

fresh
mkdir -p "$work/remote"
touch "$work/remote/.down"
sealed 20261122T070000Z
if offsite_step push; then fail 'an unreachable remote fails the push'; else ok 'an unreachable remote fails the push'; fi
check 'and is recorded' grep -q 'cannot reach fake:sipges' "$work/backups/.last-offsite-failure"
if offsite_step probe; then fail 'probe fails on an unreachable remote'; else ok 'probe fails on an unreachable remote'; fi
command rm -f "$work/remote/.down"
offsite_step probe
check 'probe passes on a remote it can write, read and clean' test -z "$(find "$work/remote" -name '.sipges-offsite-probe')"

# Fetch: the files come back only when they match their checksums.
fresh
remote=$work/remote/sipges
mkdir -p "$work/remote"
sealed 20261122T070000Z
offsite_step push
command rm -rf "$work/backups/20261122T070000Z"
offsite_step fetch 20261122T070000Z
check 'fetch brings a backup back' test -f "$work/backups/20261122T070000Z/uploads.tar.gpg"
check 'checked against its checksums' bash -c "cd '$work/backups/20261122T070000Z' && sha256sum --quiet -c SHA256SUMS"
if offsite_step fetch 20261122T070000Z; then fail 'fetch refuses a backup already here'; else ok 'fetch refuses a backup already here'; fi
command rm -rf "$work/backups/20261122T070000Z"
echo tampered >"$remote/20261122T070000Z/db.dump.gpg"
if offsite_step fetch 20261122T070000Z; then fail 'a fetched backup that does not match is refused'; else ok 'a fetched backup that does not match is refused'; fi
check 'and is not kept' test ! -e "$work/backups/20261122T070000Z"
check 'nor its partial' test -z "$(find "$work/backups" -name '.partial-*')"
command rm -f "$remote/20261122T070000Z/SHA256SUMS"
if offsite_step fetch 20261122T070000Z; then fail 'a half pushed backup cannot be fetched'; else ok 'a half pushed backup cannot be fetched'; fi
if offsite_step fetch ../etc; then fail 'fetch refuses a name that is not a backup'; else ok 'fetch refuses a name that is not a backup'; fi

command rm -rf "$root"
if ((failures > 0)); then
  printf '%d failed\n' "$failures"
  exit 1
fi
printf 'all passed\n'

