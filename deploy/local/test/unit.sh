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
case $1 in
compose)
  shift 7 # compose --env-file <file> -p <project> -f compose.yaml
  [[ ${1:-} != --profile ]] || shift 2
  case $1 in
  version | config) exit 0 ;;
  ps)
    if [[ $* == *api* ]]; then cat "$FAKE/api-container" 2>/dev/null; else echo db-container; fi
    ;;
  exec)
    [[ $* != *caddy* || ! -f $FAKE/not-ready ]] || exit 1
    [[ $* != *caddy* ]] || echo '{"status":"ready"}'
    ;;
  run)
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
run) ;;
esac
FAKE
printf '#!/usr/bin/env bash\n' >"$root/sleep"
chmod +x "$root/docker" "$root/sleep"

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

command rm -rf "$root"
if ((failures > 0)); then
  printf '%d failed\n' "$failures"
  exit 1
fi
printf 'all passed\n'
