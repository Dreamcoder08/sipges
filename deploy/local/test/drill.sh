#!/usr/bin/env bash
# The restore drill: a clean install, then sign-in, MFA, a record and evidence, a backup, a wipe, a
# restore, and the proof that everything is back. Synthetic values only, on its own project,
# ports and folder, so it never touches a real installation on the machine.
#   deploy/local/test/drill.sh [work directory]
# Needs an image built by ./sipges install or SIPGES_DRILL_BUILD=1 to build it.
set -Eeuo pipefail
here=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
local_dir=$(dirname "$here")
work=${1:-$(mktemp -d)}
mkdir -p "$work/backups"
export SIPGES_PROJECT=sipges-drill
export SIPGES_ENV_FILE="$work/drill.env"
sipges() { "$local_dir/sipges" "$@"; }
step() { printf '\n== %s\n' "$*"; }
compose_exec_psql() {
  docker compose --env-file "$SIPGES_ENV_FILE" -p "$SIPGES_PROJECT" -f "$local_dir/compose.yaml" \
    exec -T -e "PGPASSWORD=$(sed -n 's/^SIPGES_DB_ADMIN_PASSWORD=//p' "$SIPGES_ENV_FILE")" \
    db psql --no-psqlrc -qtA -U sipges_admin -d sipges -c "$1"
}
in_compose() {
  docker compose --env-file "$SIPGES_ENV_FILE" -p "$SIPGES_PROJECT" -f "$local_dir/compose.yaml" "$@"
}

cleanup() {
  docker compose --env-file "$SIPGES_ENV_FILE" -p "$SIPGES_PROJECT" -f "$local_dir/compose.yaml" \
    --profile ops down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

https_port=${SIPGES_DRILL_HTTPS_PORT:-18443}
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
SIPGES_BACKUP_KEEP=2
SIPGES_BIND_ADDRESS=127.0.0.1
SIPGES_HTTP_PORT=$((https_port - 1))
SIPGES_HTTPS_PORT=$https_port
SIPGES_AUTOMATION_INTERVAL=5
ENV
umask 022

if [[ ${SIPGES_DRILL_BUILD:-0} == 1 ]]; then
  sipges build
fi

step 'install on empty volumes'
cleanup
sipges start

step 'the certificate each computer installs'
ca="$work/ca.crt"
(cd "$work" && docker compose --env-file "$SIPGES_ENV_FILE" -p "$SIPGES_PROJECT" -f "$local_dir/compose.yaml" \
  cp caddy:/data/caddy/pki/authorities/local/root.crt "$ca")
export NODE_EXTRA_CA_CERTS=$ca SIPGES_DRILL_URL="https://localhost:$https_port" SIPGES_DRILL_PASSWORD=$password

forced_tables() { compose_exec_psql "SELECT count(*) FROM pg_class WHERE relkind = 'r' AND relforcerowsecurity"; }

step 'the login role cannot bypass row-level security'
attrs=$(compose_exec_psql "SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = 'sipges_app'")
[[ $attrs == 'f|f|f' ]] || { echo "sipges_app attributes: $attrs"; exit 1; }
owner=$(compose_exec_psql "SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'public'")
[[ $owner == sipges_app ]] || { echo "table owners: $owner"; exit 1; }
forced=$(forced_tables)
((forced > 0)) || { echo 'no table forces row-level security'; exit 1; }
echo "ok - sipges_app owns every table, has no privileged attribute, and $forced tables force RLS"

for address in '' '-h 127.0.0.1'; do
  # shellcheck disable=SC2086 # the empty case must add no argument
  if in_compose exec -T -e PGPASSWORD=wrong db psql $address -U sipges_admin -d sipges -c 'SELECT 1' >/dev/null 2>&1; then
    echo "the superuser logged in with a wrong password over \"${address:-the socket}\""
    exit 1
  fi
done
echo 'ok - the database asks for a password on its own socket and loopback'

step 'use it as a person would'
node "$here/drill-client.mjs" seed "$work/state.json"
marker=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).marker)' "$work/state.json")

step 'scheduled automation runs without the Worker cron'
for _ in $(seq 1 30); do
  ran=$(compose_exec_psql 'SELECT count(*) FROM automation_cursors WHERE last_tick_finished_at IS NOT NULL' 2>/dev/null || echo 0)
  [[ $ran != 0 ]] && break
  sleep 2
done
[[ ${ran:-0} != 0 ]] || { echo 'no automation tick was recorded'; exit 1; }
sipges logs api 2>/dev/null | grep -q automation_schedule_started
echo "ok - automation ticked for $ran project(s)"

step 'the nightly backup is on the clock'
wait_seconds=$(docker compose --env-file "$SIPGES_ENV_FILE" -p "$SIPGES_PROJECT" -f "$local_dir/compose.yaml" \
  exec -T backup bash /ops/schedule.sh --next 2)
((wait_seconds > 0 && wait_seconds <= 90000)) || { echo "next backup in $wait_seconds s"; exit 1; }
echo "ok - next nightly backup in $wait_seconds seconds"

step 'backup, encrypted, with retention'
# Bigger than a pipe: checking a backup once stopped reading early, which only a real size shows.
compose_exec_psql "INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at)
  SELECT 'SIPGES/PRJ-SECHURA', 'Compromisos', 'DRILL-LARGE',
         jsonb_build_object('Texto', string_agg(md5(random()::text), '')), now(), now()
  FROM generate_series(1, 200000)"
sipges backup
sleep 1
sipges backup
sleep 1
sipges backup
mapfile -t names < <(sipges backups)
((${#names[@]} == 2)) || { echo "kept ${#names[@]} backups, want 2"; exit 1; }
echo 'ok - retention kept the 2 newest'
name=${names[-1]}
if grep -r -q -a -e "$marker" -e 'synthetic drill record' "$work/backups/$name"; then
  echo 'the backup holds readable data'
  exit 1
fi
echo 'ok - no synthetic value is readable in the backup'

step 'a wrong passphrase and a damaged file change nothing'
sed "s/^SIPGES_BACKUP_PASSPHRASE=.*/SIPGES_BACKUP_PASSPHRASE=wrong/" "$SIPGES_ENV_FILE" >"$work/wrong.env"
if SIPGES_ENV_FILE="$work/wrong.env" sipges restore "$name" --yes; then
  echo 'a wrong passphrase restored'
  exit 1
fi
sipges start
kept=$(compose_exec_psql "SELECT count(*) FROM module_records WHERE id = '$marker'")
[[ $kept == 1 ]] || { echo "after the refused restore: $kept"; exit 1; }
echo 'ok - the wrong passphrase left the data in place'
oldest=${names[0]}
# Inverts one byte: writing a fixed one leaves the file unchanged when that byte already holds it.
node -e 'const f = require("fs"), p = process.argv[1], b = f.readFileSync(p); b[4096] ^= 255; f.writeFileSync(p, b)' \
  "$work/backups/$oldest/db.dump.gpg"
if sipges restore "$oldest" --yes; then
  echo 'a damaged backup restored'
  exit 1
fi
sipges start
kept=$(compose_exec_psql "SELECT count(*) FROM module_records WHERE id = '$marker'")
[[ $kept == 1 ]] || { echo "after the damaged restore: $kept"; exit 1; }
echo 'ok - the damaged backup left the data in place'

step 'a backup that cannot finish leaves nothing behind'
docker compose --env-file "$SIPGES_ENV_FILE" -p "$SIPGES_PROJECT" -f "$local_dir/compose.yaml" stop db
if sipges backup; then
  echo 'a backup succeeded without a database'
  exit 1
fi
[[ -z $(find "$work/backups" -maxdepth 1 -name '.partial-*') ]] || { echo 'a partial backup remains'; exit 1; }
(($(sipges backups | wc -l) == 2)) || { echo 'a failed backup removed older ones'; exit 1; }
sipges start
echo 'ok - nothing partial, and the older backups stay'

step 'a mistyped command fails'
if sipges bakup >/dev/null 2>&1; then
  echo 'a mistyped command reported success'
  exit 1
fi
echo 'ok - refused'

step 'wipe'
sipges wipe --yes
[[ -z $(docker volume ls -q --filter "name=${SIPGES_PROJECT}_") ]] || { echo 'volumes remain'; exit 1; }
sipges start
compose_ca="$work/ca-after-wipe.crt"
docker compose --env-file "$SIPGES_ENV_FILE" -p "$SIPGES_PROJECT" -f "$local_dir/compose.yaml" \
  cp caddy:/data/caddy/pki/authorities/local/root.crt "$compose_ca"
node_env=(NODE_EXTRA_CA_CERTS="$compose_ca")
env "${node_env[@]}" node "$here/drill-client.mjs" absent "$work/state.json"

step 'restore'
sipges restore "$name" --yes

expected_files=$(in_compose exec -T backup find /data/uploads -type f -not -path '*/.before-restore/*' | wc -l)

step 'everything is back'
env "${node_env[@]}" node "$here/drill-client.mjs" check "$work/state.json"
large=$(compose_exec_psql "SELECT count(*) FROM module_records WHERE id = 'DRILL-LARGE'")
[[ $large == 1 ]] || { echo "the large record came back $large times"; exit 1; }
owner=$(compose_exec_psql "SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'public'")
[[ $owner == sipges_app && $(forced_tables) == "$forced" ]] || { echo "after restore: owner $owner"; exit 1; }
echo "ok - the restored tables keep their owner and $forced forced policies"
sipges status

step 'a restore stopped halfway says so, keeps SIPGES off, and finishes on the next run'
for stage in before-files after-files; do
  if SIPGES_DRILL_STOP_AFTER_SWAP=$stage sipges restore "$name" --yes >"$work/halfway.log" 2>&1; then
    echo "a restore stopped at $stage reported success"
    exit 1
  fi
  grep -q 'stopped halfway' "$work/halfway.log" || { cat "$work/halfway.log"; exit 1; }
  if sipges start >"$work/refused-start.log" 2>&1; then
    echo "SIPGES started on a restore stopped at $stage"
    exit 1
  fi
  grep -q 'did not finish' "$work/refused-start.log" || { cat "$work/refused-start.log"; exit 1; }

  # Another backup is refused while this one is unfinished, and the guard must survive that.
  if sipges restore "$oldest" --yes >"$work/other.log" 2>&1; then
    echo 'another backup was restored over an unfinished one'
    exit 1
  fi
  grep -q 'did not finish: run that one again first' "$work/other.log" || { cat "$work/other.log"; exit 1; }
  if sipges start >"$work/refused-start.log" 2>&1; then
    echo 'the refused restore released the guard'
    exit 1
  fi

  sipges restore "$name" --yes
  files=$(in_compose exec -T backup find /data/uploads -type f -not -path '*/.before-restore/*' | wc -l)
  [[ $files == "$expected_files" ]] || { echo "after $stage: $files files, want $expected_files"; exit 1; }
  [[ -z $(compose_exec_psql "SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = 'sipges'") ]] ||
    { echo 'the restore left its marker'; exit 1; }
  kept=$(compose_exec_psql "SELECT count(*) FROM module_records WHERE id = '$marker'")
  [[ $kept == 1 ]] || { echo "after $stage: $kept"; exit 1; }
  echo "ok - stopped $stage, refused to start, and the next run finished it"
done

step 'retention never removes the backup it just wrote'
mkdir "$work"/backups/2099123{1T235959Z,1T235958Z,1T235957Z}
sipges backup
written=$(sipges backups | grep -v '^2099' | tail -n 1)
[[ -n $written && -f $work/backups/$written/db.dump.gpg ]] || { echo 'the new backup is gone'; exit 1; }
(($(sipges backups | wc -l) == 2)) || { echo "kept: $(sipges backups)"; exit 1; }
find "$work/backups" -mindepth 1 -maxdepth 1 -type d -name '2099*' -empty -delete
before=$(sipges backups)
if in_compose exec -T -e SIPGES_BACKUP_KEEP=0 backup bash /ops/backup.sh; then
  echo 'SIPGES_BACKUP_KEEP=0 was accepted'
  exit 1
fi
[[ $(sipges backups) == "$before" ]] || { echo 'the refused backup changed the set'; exit 1; }
echo 'ok - the new backup stays, and keeping none is refused'

step 'an explicit address replaces the one in use'
sipges install 127.0.0.1
grep -q '^SIPGES_SITE_HOST=127.0.0.1$' "$SIPGES_ENV_FILE" || { echo 'the address was ignored'; exit 1; }
code=$(curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:$https_port/health")
[[ $code == 200 ]] || { echo "the new address answered $code"; exit 1; }
echo 'ok - the new address serves'
step 'drill passed'
