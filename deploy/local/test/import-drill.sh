#!/usr/bin/env bash
# The import drill: synthetic client files, read from a folder outside the repository, through both
# import paths, with no TypeScript. Own project, ports and folder. Node only writes the fixtures
# and plays the browser.
#   deploy/local/test/import-drill.sh [work directory]
set -Eeuo pipefail
here=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
local_dir=$(dirname "$here")
work=${1:-$(mktemp -d)}
mkdir -p "$work/backups"
export SIPGES_PROJECT=sipges-import-drill
export SIPGES_ENV_FILE="$work/drill.env"
export SIPGES_IMPORT_REPORTS="$work/reports"
sipges() { "$local_dir/sipges" "$@"; }
step() { printf '\n== %s\n' "$*"; }
in_compose() {
  docker compose --env-file "$SIPGES_ENV_FILE" -p "$SIPGES_PROJECT" -f "$local_dir/compose.yaml" "$@"
}
admin_password() { sed -n 's/^SIPGES_DB_ADMIN_PASSWORD=//p' "$SIPGES_ENV_FILE"; }
sql() { in_compose exec -T -e "PGPASSWORD=$(admin_password)" db psql --no-psqlrc -qtA -U sipges_admin -d sipges -c "$1"; }
# Every row of every table of the schema, hashed: a dry run must leave this exactly as it was.
fingerprint() {
  in_compose exec -T -e "PGPASSWORD=$(admin_password)" db bash -c 'pg_dump -U sipges_admin -d sipges --data-only --inserts | grep -v "^\\\\\|^--" | sha256sum'
}
counts() { sql "SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM tenants), (SELECT count(*) FROM module_records), (SELECT count(*) FROM attachments)"; }

cleanup() { in_compose --profile ops down --volumes --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

https_port=${SIPGES_DRILL_HTTPS_PORT:-18543}
legacy_password=synthetic-legacy-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')
hex() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
umask 077
cat >"$SIPGES_ENV_FILE" <<ENV
SIPGES_SITE_HOST=localhost
SIPGES_ADMIN_USERNAME=admin
SIPGES_ADMIN_PASSWORD=synthetic-$(hex)
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
node --no-warnings "$here/make-import-fixtures.mjs" "$work/client" "$legacy_password"
# As the guide asks: other accounts of the machine reach nothing, and the tools read through the
# group they are given.
chmod -R u+rwX,g+rX,o-rwx "$work/client"

client_sum() { tar -C "$work/client" --sort=name --mtime=@0 -cf - . | sha256sum; }
client_before=$(client_sum)

step 'prepare: database and migrations, no application'
cleanup
mkdir -p "$work/backups"
in_compose up -d db backup
[[ $(counts) == '0|0|0|0' ]] || { echo "not empty: $(counts)"; exit 1; }

step 'a folder inside the repository is refused'
if sipges import legacy "$local_dir"; then
  echo 'read a folder inside the repository'
  exit 1
fi
echo 'ok - refused'

step 'inventory: a report of the folder, and nothing else moves'
before=$(fingerprint)
sipges inventory "$work/client/mixed" | tee "$work/inventory.log"
report=$(sed -n 's/^Full report: //p' "$work/inventory.log")
[[ $(fingerprint) == "$before" ]] || { echo 'the inventory changed the database'; exit 1; }
[[ $(client_sum) == "$client_before" ]] || { echo 'the inventory changed the folder'; exit 1; }
grep -q CANARY "$report" "$work/inventory.log" && { echo 'a cell value reached the report'; exit 1; }
node --no-warnings -e '
  const report = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const assert = (ok, what) => { if (!ok) { console.error("not as expected: " + what); process.exit(1); } };
  assert(report.totals.files === 7 && report.totals.readable === 5, "totals");
  assert(report.totals.unreadable === 1 && report.totals.notInspected === 1, "verdicts");
  assert(report.duplicates.length === 1 && report.duplicates[0].paths.length === 2, "duplicates");
  const sheet = (path) => report.tables.find((t) => t.path === path).sheets[0];
  assert(sheet("book.xlsx").name === "Concesiones" && sheet("book.xlsx").dataRows === 1, "workbook");
  assert(sheet("book.xlsx").headers.join() === "Codigo,Titular", "workbook headers");
  assert(sheet("list.csv").headers.join() === "Codigo,Monto" && sheet("list.csv").dataRows === 2, "csv");
' "$report"
[[ $(in_compose --profile ops config inventory | sed -n 's/^ *network_mode: //p') == none ]] ||
  { echo 'the inventory has a network'; exit 1; }
echo 'ok - counted, no value in the report, database and folder as they were'

step 'legacy: the dry run writes nothing'
before=$(fingerprint)
sipges import legacy "$work/client/legacy"
[[ $(fingerprint) == "$before" ]] || { echo 'the dry run changed the database'; exit 1; }
[[ $(counts) == '0|0|0|0' ]] || { echo "dry run wrote: $(counts)"; exit 1; }
echo 'ok - every table is byte for byte as it was'
[[ $(stat -c %a "$SIPGES_IMPORT_REPORTS" | tail -c 4) == 700 ]] ||
  { echo 'the reports folder stayed open'; exit 1; }
find "$SIPGES_IMPORT_REPORTS" -type f -perm /o=w | grep -q . && { echo 'a report anyone may write'; exit 1; }
echo 'ok - the reports folder closed again'

step 'a folder SIPGES cannot read is named, and nothing happens'
cp -r "$work/client/legacy" "$work/locked"
chmod -R go-rwx "$work/locked"
before=$(fingerprint)
backups_before=$(sipges backups | wc -l)
if sipges import legacy "$work/locked" --apply >"$work/locked.log" 2>&1; then
  echo 'an unreadable folder was accepted'
  exit 1
fi
grep -q 'SIPGES cannot read' "$work/locked.log" || { cat "$work/locked.log"; exit 1; }
[[ $(fingerprint) == "$before" && $(sipges backups | wc -l) == "$backups_before" ]] ||
  { echo 'the refused folder changed something'; exit 1; }
chmod -R u+rwX,go+rX "$work/locked"
# Many unreadable files must be named as well: the check once died silently on the second one.
mkdir "$work/crowded"
for n in $(seq 1 3000); do : >"$work/crowded/$n"; done
chmod 600 "$work"/crowded/*
if sipges import legacy "$work/crowded" >"$work/crowded.log" 2>&1; then
  echo 'an unreadable crowded folder was accepted'
  exit 1
fi
grep -q 'SIPGES cannot read' "$work/crowded.log" || { cat "$work/crowded.log"; exit 1; }
missing=$(sipges import legacy "$work/no/such/folder" 2>&1 || true)
[[ $missing == *'no folder'* ]] || { echo "for a missing folder: $missing"; exit 1; }
echo 'ok - refused before any backup or container'

step 'legacy: apply, then verify'
sipges import legacy "$work/client/legacy" --apply
sipges import legacy "$work/client/legacy" --verify
[[ $(counts) == '1|1|1|1' ]] || { echo "after apply: $(counts)"; exit 1; }
echo 'ok - 1 user, 1 project, 1 record, 1 attachment'

step 'legacy: a second apply is refused and changes nothing'
before=$(fingerprint)
if sipges import legacy "$work/client/legacy" --apply; then
  echo 'a second apply succeeded'
  exit 1
fi
[[ $(fingerprint) == "$before" ]] || { echo 'the second apply changed the database'; exit 1; }
echo 'ok - insert-only'

step 'the source was only read'
[[ $(client_sum) == "$client_before" ]] || { echo 'the client folder changed'; exit 1; }
echo 'ok - the folder is byte for byte as it arrived'

step 'start, and sign in as the migrated person with the old password'
sipges start
ca="$work/ca.crt"
in_compose cp caddy:/data/caddy/pki/authorities/local/root.crt "$ca"
NODE_EXTRA_CA_CERTS=$ca SIPGES_DRILL_URL="https://localhost:$https_port" \
  SIPGES_DRILL_USER=legacy.admin SIPGES_DRILL_PASSWORD=$legacy_password \
  node "$here/drill-client.mjs" imported "$work/state.json"

step 'base maestra: the dry run writes nothing'
before=$(fingerprint)
sipges import base-maestra "$work/client/seed/seed.json"
[[ $(fingerprint) == "$before" ]] || { echo 'the dry run changed the database'; exit 1; }
echo 'ok'

step 'base maestra: a row of another project stops the whole file'
if sipges import base-maestra "$work/client/seed/foreign.json" --apply; then
  echo 'a foreign row was accepted'
  exit 1
fi
[[ $(fingerprint) == "$before" ]] || { echo 'the refused file changed the database'; exit 1; }
echo 'ok - nothing written'

step 'base maestra: apply, then apply again'
sipges import base-maestra "$work/client/seed/seed.json" --apply
rows=$(sql "SELECT count(*) FROM module_records WHERE id LIKE 'SEED-%'")
[[ $rows == 3 ]] || { echo "seed rows: $rows"; exit 1; }
sql "UPDATE module_records SET payload = payload || '{\"Texto\":\"edited after import\"}' WHERE id = 'SEED-1'"
sipges import base-maestra "$work/client/seed/seed.json" --apply
rows=$(sql "SELECT count(*) FROM module_records WHERE id LIKE 'SEED-%'")
kept=$(sql "SELECT payload->>'Texto' FROM module_records WHERE id = 'SEED-1'")
[[ $rows == 3 && $kept == 'edited after import' ]] || { echo "after re-apply: $rows, $kept"; exit 1; }
echo 'ok - no duplicate, and the edit stands'
step 'import drill passed'
