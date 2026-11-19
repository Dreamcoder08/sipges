#!/usr/bin/env bash
# Rehearses deploy/cloud/move-postgres.sh between two throwaway PostgreSQL clusters on loopback,
# with synthetic data only (docs/deployment/planetscale-move.md, "What was proven locally"):
#   - the source is shaped like production on Neon: a non-superuser owner with BYPASSRLS and
#     CREATEROLE, and default privileges for a platform role (neon_superuser) the target lacks;
#   - the target is an empty database owned by an admin shaped like PlanetScale's default role
#     (no superuser; BYPASSRLS, CREATEROLE, CREATEDB); the admin and sipges_app sign in with
#     passwords (scram-sha-256) carried in their URLs, never by trust;
#   - pg-secrets.mjs keeps a PlanetScale-style query string byte for byte (pg-secrets.test.mjs);
#   - a move that fails in the restore leaves no stand-in role; one killed before it can clean up
#     leaves only its private sipges-move.* folder and its stand-ins, which the retry drops while
#     finding sipges_app already there; a cleanup that cannot list its stand-ins fails loudly;
#   - no password ever reaches the argv of psql, pg_dump or pg_restore (logged through shims);
#   - an existing sipges_app or sipges_tenant with SUPERUSER, BYPASSRLS, CREATEDB, CREATEROLE or
#     REPLICATION, and a target that is the source, are refused;
#   - after the move: the source is byte-identical, `migrate` as sipges_app finds nothing to do,
#     and every planted fault on the target makes `verify` fail.
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
# On the target, the admin and sipges_app must prove their passwords; the cluster's superuser
# (used only to plant faults) is trusted on loopback.
initdb -D "$work/target" -U sipges_test --auth=trust -E UTF8 >/dev/null
printf 'host all sipges_app,ps_admin 127.0.0.1/32 scram-sha-256\nhost all all 127.0.0.1/32 trust\n' >"$work/target/pg_hba.conf"
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
hex() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
admin_password=$(hex)
app_password=$(hex)
superuser_dst="postgres://sipges_test@127.0.0.1:$dst_port"
ADMIN_PASSWORD="$admin_password" psql "$admin_dst" -X -q -v ON_ERROR_STOP=1 <<'SQL'
\getenv admin_password ADMIN_PASSWORD
CREATE ROLE ps_admin LOGIN NOSUPERUSER CREATEDB CREATEROLE INHERIT REPLICATION BYPASSRLS
  IN ROLE pg_read_all_data, pg_write_all_data PASSWORD :'admin_password';
SQL
PGPASSWORD="$admin_password" psql "postgres://ps_admin@127.0.0.1:$dst_port/postgres" -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE sipges"

unset PGPASSWORD
export SIPGES_MOVE_SOURCE_URL="$src_owner"
export SIPGES_MOVE_TARGET_URL="postgres://ps_admin:$admin_password@127.0.0.1:$dst_port/sipges"
export SIPGES_MOVE_APP_URL="postgres://sipges_app:$app_password@127.0.0.1:$dst_port/sipges"
export SIPGES_MOVE_APP_PASSWORD="$app_password"

# Shims in front of the PostgreSQL clients the tool runs: each logs its argv, and pg_restore can
# fail, or kill the tool itself, when REHEARSE_RESTORE_FAULT says so.
mkdir -p "$work/shims"
export REHEARSE_ARGV_LOG="$work/argv.log" REHEARSE_REAL_PATH="$PATH"
for client in psql pg_dump pg_restore; do
  cat >"$work/shims/$client" <<'SHIM'
#!/usr/bin/env bash
name=$(basename "$0")
printf '%s %s\n' "$name" "$*" >>"$REHEARSE_ARGV_LOG"
if [ "$name" = psql ] && [ "${REHEARSE_PSQL_FAULT:-}" = list ] && [[ " $* " == *" marker="* ]]; then
  # The stand-in listing is the first call that passes the marker; stdin is never read, so the
  # snapshot session's stream stays untouched.
  echo "rehearsal: the stand-in listing fails" >&2
  exit 1
fi
if [ "$name" = pg_restore ] && [[ " $* " == *" --dbname="* ]]; then
  case "${REHEARSE_RESTORE_FAULT:-}" in
    fail) exit 1 ;;
    kill) kill -KILL "$PPID"; exit 1 ;;
  esac
fi
exec "$(PATH="$REHEARSE_REAL_PATH" command -v "$name")" "$@"
SHIM
  chmod +x "$work/shims/$client"
done
run_move() { PATH="$work/shims:$PATH" "$move" "$@"; }
stand_ins() {
  psql "$superuser_dst/postgres" -X -At -c \
    "SELECT count(*) FROM pg_roles WHERE rolname IN ('neon_superuser', 'mascli_workers')"
}

step "pg-secrets keeps PlanetScale-style URLs byte for byte"
SIPGES_TEST_DATABASE_URL="$admin_dst" node --test "$here/pg-secrets.test.mjs" 2>&1 | grep -E '^# (pass|fail)'
SIPGES_TEST_DATABASE_URL="$admin_dst" node --test "$here/pg-secrets.test.mjs" >/dev/null 2>&1 ||
  fail "pg-secrets.test.mjs failed"

step "A move that fails in the restore leaves no stand-in role"
if REHEARSE_RESTORE_FAULT=fail run_move move "$work/failed" >"$work/failed.log" 2>&1; then
  fail "the move passed with a failing restore"
fi
tail -2 "$work/failed.log"
[ "$(stand_ins)" = 0 ] || fail "a failed move left stand-in roles"
echo "failed move: no stand-in role left"

step "A move killed before it can clean up: the retry drops what it left"
mkdir -p "$work/tmp"
if REHEARSE_RESTORE_FAULT=kill TMPDIR="$work/tmp" run_move move "$work/killed" >"$work/killed.log" 2>&1; then
  fail "the move survived being killed"
fi
[ "$(stand_ins)" = 2 ] || fail "the killed move should have left its 2 stand-ins for the retry"
# What the guide says to delete after a kill: the private folder, which holds the passwords.
left_behind=("$work"/tmp/sipges-move.*)
[ "${#left_behind[@]}" = 1 ] && [ -f "${left_behind[0]}/pgpass" ] ||
  fail "the killed move should have left exactly one sipges-move.* folder with its password file"
rm -rf -- "${left_behind[@]}"
echo "killed move: left 2 stand-ins and one private sipges-move.* folder, now deleted"

step "A cleanup that cannot list its stand-ins fails loudly"
if REHEARSE_PSQL_FAULT=list run_move move "$work/unlisted" >"$work/unlisted.log" 2>&1 </dev/null; then
  fail "the move passed although it could not list its stand-ins"
fi
grep -F "could not list the stand-in roles" "$work/unlisted.log" || { cat "$work/unlisted.log"; fail "no loud failure"; }
[ "$(stand_ins)" = 2 ] || fail "the stand-ins should still be there for the next move"

step "Move (the retry: sipges_app and the stand-ins already exist)"
mkdir -p "$work/tmp"
TMPDIR="$work/tmp" run_move move "$work/move"
[ "$(stand_ins)" = 0 ] || fail "the retry left stand-in roles"
[ -z "$(ls -A "$work/tmp")" ] || fail "a finished move left its private folder behind"

step "No password reached any client's argv"
[ -s "$work/argv.log" ] || fail "the shims logged nothing"
if grep -F -e "$admin_password" -e "$app_password" "$work/argv.log" >/dev/null; then
  fail "a password appeared in the argv of a PostgreSQL client"
fi
echo "argv: $(wc -l <"$work/argv.log") client calls, no password"

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
if PGPASSWORD=wrong psql "postgres://sipges_app@127.0.0.1:$dst_port/sipges" -X -At -c 'SELECT 1' >/dev/null 2>&1; then
  fail "sipges_app signed in with a wrong password"
fi
echo "sipges_app: wrong password refused"

expect_refusal() { # label expected-text, then the command
  local label=$1 expected=$2
  shift 2
  if "$@" >"$work/refused.log" 2>&1; then
    cat "$work/refused.log"
    fail "$label was not refused"
  fi
  grep -F "$expected" "$work/refused.log" || { cat "$work/refused.log"; fail "$label: expected \"$expected\""; }
}

step "Refusals"
psql "$superuser_dst/postgres" -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE sipges2 OWNER ps_admin"
expect_role_refusal() { # role attribute
  psql "$superuser_dst/postgres" -X -q -v ON_ERROR_STOP=1 -c "ALTER ROLE $1 $2"
  SIPGES_MOVE_TARGET_URL="${SIPGES_MOVE_TARGET_URL%/sipges}/sipges2" \
    SIPGES_MOVE_APP_URL="${SIPGES_MOVE_APP_URL%/sipges}/sipges2" \
    expect_refusal "an existing $1 with $2" "$1 exists with $2: refusing to reuse it" \
    run_move move "$work/refused-$1-$2"
  [ "$(stand_ins)" = 0 ] || fail "the refused move left stand-in roles"
  psql "$superuser_dst/postgres" -X -q -v ON_ERROR_STOP=1 -c "ALTER ROLE $1 NO$2"
}
expect_role_refusal sipges_app BYPASSRLS
expect_role_refusal sipges_app CREATEDB
expect_role_refusal sipges_app CREATEROLE
expect_role_refusal sipges_app REPLICATION
expect_role_refusal sipges_tenant REPLICATION
psql "$superuser_dst/postgres" -X -q -v ON_ERROR_STOP=1 -c "DROP DATABASE sipges2"
SIPGES_MOVE_TARGET_URL="$SIPGES_MOVE_SOURCE_URL" \
  expect_refusal "a target that is the source (verify)" "the target is the source database" \
  run_move verify "$work/same"
SIPGES_MOVE_TARGET_URL="$SIPGES_MOVE_SOURCE_URL" \
  expect_refusal "a target that is the source (move)" "the target is the source database" \
  run_move move "$work/same-move"

expect_verify_failure() { # label sql-to-break sql-to-repair
  psql "$fault_url" -X -q -v ON_ERROR_STOP=1 -c "$2"
  if run_move verify "$work/fault" >"$work/fault.log" 2>&1; then
    cat "$work/fault.log"
    fail "verify passed with $1"
  fi
  grep -vE 'identical|each seen only|^privileges: ok' "$work/fault.log" | sed "s#$work#<work>#g"
  psql "$fault_url" -X -q -v ON_ERROR_STOP=1 -c "$3"
  rm -rf "$work/fault"
  echo "verify: caught $1"
}

step "Faults on the target make verify fail"
# Injected as the cluster's superuser: the admin cannot touch what sipges_app now owns.
fault_url="$superuser_dst/sipges"
expect_verify_failure "one changed row" \
  "ALTER TABLE module_records DISABLE TRIGGER USER; UPDATE module_records SET payload = payload || '{\"x\":1}' WHERE id = 'awkward-2'; ALTER TABLE module_records ENABLE TRIGGER USER;" \
  "ALTER TABLE module_records DISABLE TRIGGER USER; UPDATE module_records SET payload = payload - 'x' WHERE id = 'awkward-2'; ALTER TABLE module_records ENABLE TRIGGER USER;"
expect_verify_failure "a lifted FORCE ROW LEVEL SECURITY" \
  "ALTER TABLE module_records NO FORCE ROW LEVEL SECURITY;" \
  "ALTER TABLE module_records FORCE ROW LEVEL SECURITY;"
expect_verify_failure "sipges_app with BYPASSRLS" \
  "ALTER ROLE sipges_app BYPASSRLS;" \
  "ALTER ROLE sipges_app NOBYPASSRLS;"
expect_verify_failure "a table grant to another role" \
  "CREATE ROLE intruder NOLOGIN; GRANT SELECT ON module_records TO intruder;" \
  "REVOKE SELECT ON module_records FROM intruder; DROP ROLE intruder;"
expect_verify_failure "a function grant to another role" \
  "CREATE ROLE intruder NOLOGIN; GRANT EXECUTE ON FUNCTION sipges_can_see(text) TO intruder;" \
  "REVOKE EXECUTE ON FUNCTION sipges_can_see(text) FROM intruder; DROP ROLE intruder;"
expect_verify_failure "CREATE on the schema for PUBLIC" \
  "GRANT CREATE ON SCHEMA public TO PUBLIC;" \
  "REVOKE CREATE ON SCHEMA public FROM PUBLIC;"
expect_verify_failure "default privileges for PUBLIC" \
  "ALTER DEFAULT PRIVILEGES FOR ROLE sipges_app IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC;" \
  "ALTER DEFAULT PRIVILEGES FOR ROLE sipges_app IN SCHEMA public REVOKE SELECT ON TABLES FROM PUBLIC;"
expect_verify_failure "default privileges for another role" \
  "CREATE ROLE intruder NOLOGIN; ALTER DEFAULT PRIVILEGES FOR ROLE sipges_app IN SCHEMA public GRANT SELECT ON TABLES TO intruder;" \
  "ALTER DEFAULT PRIVILEGES FOR ROLE sipges_app IN SCHEMA public REVOKE SELECT ON TABLES FROM intruder; DROP ROLE intruder;"
expect_verify_failure "sipges_app a member of a BYPASSRLS role" \
  "CREATE ROLE bypasser NOLOGIN BYPASSRLS; GRANT bypasser TO sipges_app;" \
  "REVOKE bypasser FROM sipges_app; DROP ROLE bypasser;"
expect_verify_failure "sipges_tenant a member of a superuser role" \
  "GRANT sipges_test TO sipges_tenant;" \
  "REVOKE sipges_test FROM sipges_tenant;"
expect_verify_failure "a leftover stand-in role" \
  "CREATE ROLE neon_superuser NOLOGIN; COMMENT ON ROLE neon_superuser IS 'sipges-move stand-in';" \
  "DROP ROLE neon_superuser;"

step "Verify after the repairs"
run_move verify "$work/final"

echo
echo "rehearsal: ok"
