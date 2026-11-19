#!/usr/bin/env bash
# Rehearses deploy/cloud/move-postgres.sh between two throwaway PostgreSQL clusters on loopback,
# with synthetic data only (docs/deployment/planetscale-move.md, "Rehearsal"):
#   - the source is shaped like production on Neon: a non-superuser owner with BYPASSRLS and
#     CREATEROLE, and default privileges for a platform role (neon_superuser) the target lacks;
#   - the target is an empty database owned by an admin shaped like PlanetScale's default role
#     (no superuser; BYPASSRLS, CREATEROLE, CREATEDB), and sipges_app must sign in
#     with the password the move sets (scram-sha-256), never by trust;
#   - after the move: the source is byte-identical, `migrate` as sipges_app finds nothing to do,
#     and three deliberate faults on the target (a changed row, a lifted FORCE, sipges_app with
#     BYPASSRLS) each make `verify` fail.
#   deploy/cloud/test/rehearse-move.sh [work directory]
# Needs PostgreSQL 18 client and server binaries (initdb, pg_ctl, psql, pg_dump) and Node 22.
set -Eeuo pipefail
here=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
repo_root=$(cd "$here/../../.." && pwd)
move="$here/../move-postgres.sh"
work=${1:-$(mktemp -d)}
mkdir -p "$work"
step() { printf '\n== %s\n' "$*"; }
fail() {
  echo "rehearsal FAILED: $*" >&2
  exit 1
}

free_port() {
  local port=$1
  while (: </dev/tcp/127.0.0.1/"$port") 2>/dev/null; do port=$((port + 1)); done
  echo "$port"
}

started=()
cleanup() {
  for cluster in "${started[@]}"; do pg_ctl -D "$cluster" -w -m fast stop >/dev/null 2>&1 || true; done
}
trap cleanup EXIT

cluster() { # name port: a loopback cluster whose admin is sipges_test, with no Unix socket
  initdb -D "$work/$1" -U sipges_test --auth=trust -E UTF8 >/dev/null
  pg_ctl -D "$work/$1" -w -l "$work/$1.log" \
    -o "-p $2 -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c timezone=UTC" start >/dev/null
  started+=("$work/$1")
}

src_port=$(free_port 57439)
cluster source "$src_port"
dst_port=$(free_port $((src_port + 1)))
# On the target, sipges_app must prove its password; everyone else is trusted on loopback.
initdb -D "$work/target" -U sipges_test --auth=trust -E UTF8 >/dev/null
printf 'host all sipges_app 127.0.0.1/32 scram-sha-256\nhost all all 127.0.0.1/32 trust\n' >"$work/target/pg_hba.conf"
pg_ctl -D "$work/target" -w -l "$work/target.log" \
  -o "-p $dst_port -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c timezone=UTC" start >/dev/null
started+=("$work/target")

admin_src="postgres://sipges_test@127.0.0.1:$src_port/postgres"
admin_dst="postgres://sipges_test@127.0.0.1:$dst_port/postgres"

step "Source shaped like production on Neon"
psql "$admin_src" -X -q -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE neon_superuser NOLOGIN;
CREATE ROLE mascli_workers LOGIN NOSUPERUSER CREATEROLE BYPASSRLS IN ROLE neon_superuser;
CREATE DATABASE mascli_workers OWNER mascli_workers;
SQL
psql "postgres://sipges_test@127.0.0.1:$src_port/mascli_workers" -X -q -v ON_ERROR_STOP=1 <<'SQL'
ALTER DEFAULT PRIVILEGES FOR ROLE mascli_workers IN SCHEMA public
  GRANT ALL ON TABLES TO neon_superuser WITH GRANT OPTION;
ALTER DEFAULT PRIVILEGES FOR ROLE mascli_workers IN SCHEMA public
  GRANT ALL ON SEQUENCES TO neon_superuser WITH GRANT OPTION;
SQL
src_owner="postgres://mascli_workers@127.0.0.1:$src_port/mascli_workers"
src_admin="postgres://sipges_test@127.0.0.1:$src_port/mascli_workers"
(cd "$repo_root" && SIPGES_MIGRATION_DATABASE_URL="$src_owner" node apps/hosting-cloudflare/migrate.mjs)

step "Synthetic rows: parity fixtures, two more projects, awkward values"
psql "$src_admin" -X -q -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO tenants (company_id, project_id, label) VALUES
  ('SIPGES', 'PRJ-SECHURA', 'Proyecto sintético'), ('PARITY', 'PRJ-B', 'Segundo sintético'),
  ('ACME', 'NORTE', 'Norte sintético') ON CONFLICT DO NOTHING;
SQL
(cd "$repo_root/apps/parity" && SRC="$src_admin" node --input-type=module -e \
  "const { seedDatabase } = await import('./src/fixtures.ts'); await seedDatabase(process.env.SRC);")
psql "$src_owner" -X -q -v ON_ERROR_STOP=1 <<'SQL'
-- Through the owner, so the history trigger records versions as it does in production.
INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at) VALUES
  ('ACME/NORTE', 'Eventos', 'awkward-1',
   '{"name":"Ñandú \"quoted\" back\\slash","emoji":"🌎","nothing":null,"n":1.5e-7}', now(), now()),
  ('ACME/NORTE', 'Eventos', 'awkward-2', '{"tab":"a\tb","newline":"x\ny"}', now(), now());
UPDATE module_records SET payload = payload || '{"edited":true}' WHERE id = 'awkward-1';
SQL
psql "$src_admin" -X -At -c "SELECT 'rows: ' || sum(n_live_tup) || ' in ' || count(*) || ' tables' FROM pg_stat_user_tables" || true
pg_dump --no-sync -Fp --restrict-key=rehearsal --file="$work/source-before.sql" "$src_admin"

step "Empty target, its admin shaped like PlanetScale's default role"
# PlanetScale's `postgres` role: NOSUPERUSER CREATEDB CREATEROLE BYPASSRLS, with pg_read_all_data
# and pg_write_all_data (https://planetscale.com/docs/postgres/connecting/roles). It creates the
# database, so it owns it, as the guide asks.
psql "$admin_dst" -X -q -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE ps_admin LOGIN NOSUPERUSER CREATEDB CREATEROLE INHERIT REPLICATION BYPASSRLS
  IN ROLE pg_read_all_data, pg_write_all_data;
SQL
psql "postgres://ps_admin@127.0.0.1:$dst_port/postgres" -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE sipges"
app_password=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')

export SIPGES_MOVE_SOURCE_URL="$src_owner"
export SIPGES_MOVE_TARGET_URL="postgres://ps_admin@127.0.0.1:$dst_port/sipges"
export SIPGES_MOVE_APP_URL="postgres://sipges_app@127.0.0.1:$dst_port/sipges"
export PGPASSWORD="$app_password" # read only by the sipges_app connections; trust ignores it
export SIPGES_MOVE_APP_PASSWORD="$app_password"

step "Move"
"$move" move "$work/move"

step "The source was only read"
pg_dump --no-sync -Fp --restrict-key=rehearsal --file="$work/source-after.sql" "$src_admin"
# A fixed restrict key: pg_dump 18 otherwise writes a random one into every dump.
cmp -s "$work/source-before.sql" "$work/source-after.sql" || fail "the source changed during the move"
echo "source: identical dump before and after"

step "Deploy-time migrate as sipges_app finds nothing to apply"
out=$(cd "$repo_root" && SIPGES_MIGRATION_DATABASE_URL="$SIPGES_MOVE_APP_URL" node apps/hosting-cloudflare/migrate.mjs)
grep -E '^(Database up to date|Applied)' <<<"$out" || true
grep -q '^Database up to date' <<<"$out" || fail "migrate as sipges_app did not find the database up to date"

step "A wrong password is refused"
if PGPASSWORD=wrong psql "$SIPGES_MOVE_APP_URL" -X -At -c 'SELECT 1' >/dev/null 2>&1; then
  fail "sipges_app signed in with a wrong password"
fi
echo "sipges_app: wrong password refused"

expect_verify_failure() { # label sql-to-break sql-to-repair
  psql "$fault_url" -X -q -v ON_ERROR_STOP=1 -c "$2"
  if "$move" verify "$work/fault" >"$work/fault.log" 2>&1; then
    cat "$work/fault.log"
    fail "verify passed with $1"
  fi
  grep -vE 'identical|each seen only' "$work/fault.log" | sed "s#$work#<work>#g"
  psql "$fault_url" -X -q -v ON_ERROR_STOP=1 -c "$3"
  rm -rf "$work/fault"
  echo "verify: caught $1"
}

step "Faults on the target make verify fail"
# Injected as the cluster's superuser: the admin cannot touch what sipges_app now owns.
fault_url="postgres://sipges_test@127.0.0.1:$dst_port/sipges"
expect_verify_failure "one changed row" \
  "ALTER TABLE module_records DISABLE TRIGGER USER; UPDATE module_records SET payload = payload || '{\"x\":1}' WHERE id = 'awkward-2'; ALTER TABLE module_records ENABLE TRIGGER USER;" \
  "ALTER TABLE module_records DISABLE TRIGGER USER; UPDATE module_records SET payload = payload - 'x' WHERE id = 'awkward-2'; ALTER TABLE module_records ENABLE TRIGGER USER;"
expect_verify_failure "a lifted FORCE ROW LEVEL SECURITY" \
  "ALTER TABLE module_records NO FORCE ROW LEVEL SECURITY;" \
  "ALTER TABLE module_records FORCE ROW LEVEL SECURITY;"
expect_verify_failure "sipges_app with BYPASSRLS" \
  "ALTER ROLE sipges_app BYPASSRLS;" \
  "ALTER ROLE sipges_app NOBYPASSRLS;"

step "Verify after the repairs"
"$move" verify "$work/final"

echo
echo "rehearsal: ok"
