#!/usr/bin/env bash
# Moves the SIPGES database from one PostgreSQL to another (docs/deployment/planetscale-move.md):
#   1. preflight: client and server versions, who each login is, an empty target;
#   2. on the source, in ONE read-only snapshot: a row hash of every table, the shape (columns,
#      constraints, indexes, policies, triggers, functions, grants) and pg_dump of that snapshot;
#   3. on the target, as its admin: the roles, pg_restore in one transaction (all or nothing), the
#      objects handed to sipges_app, the login with no BYPASSRLS that the APIs use;
#   4. proof: the same hashes and shape on the target, no privilege beyond what SIPGES grants, and
#      row-level security as sipges_app.
# The source is only read: every source session runs with default_transaction_read_only=on.
# Passwords never reach a process argument: they go from the URLs into a private password file,
# and sipges_app's password reaches the server only as a SCRAM-SHA-256 verifier.
#
# Usage: deploy/cloud/move-postgres.sh preflight|move|verify <work dir>
#   preflight  checks only, writes nothing anywhere
#   move       preflight, dump, restore, hand over, verify
#   verify     the proof again, against the source as it is now (source must be quiescent)
# Environment (never printed; postgres:// URLs, each with its password):
#   SIPGES_MOVE_SOURCE_URL    direct (not pooled) URL of the source, as a login whose own
#                             attributes include BYPASSRLS (membership never passes it on)
#   SIPGES_MOVE_TARGET_URL    direct URL of the EMPTY target database, as its owner with
#                             BYPASSRLS and CREATEROLE (PlanetScale's default role) or a superuser
#   SIPGES_MOVE_APP_PASSWORD  password of sipges_app (move only; printable ASCII; the role is
#                             created if missing, and refused if it bypasses RLS)
#   SIPGES_MOVE_APP_URL       direct URL of the target as sipges_app (move and verify)
#   SIPGES_MOVE_SCHEMA        schema to move (default public)
# Needs psql, pg_dump and pg_restore at least as new as the source server, and Node 22.
set -euo pipefail
umask 077

die() {
  echo "move-postgres: $*" >&2
  exit 1
}

usage() {
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
}

[ $# -eq 2 ] || {
  usage >&2
  exit 2
}
command="$1"
work="$2"
case "$command" in preflight | move | verify) ;; -h | --help) usage; exit 0 ;; *) usage >&2; exit 2 ;; esac

: "${SIPGES_MOVE_SOURCE_URL:?SIPGES_MOVE_SOURCE_URL is required}"
: "${SIPGES_MOVE_TARGET_URL:?SIPGES_MOVE_TARGET_URL is required}"
schema="${SIPGES_MOVE_SCHEMA:-public}"
[[ "$schema" =~ ^[a-z_][a-z0-9_]*$ ]] || die "SIPGES_MOVE_SCHEMA must be a plain lower-case name"
if [ "$command" != preflight ]; then
  : "${SIPGES_MOVE_APP_URL:?SIPGES_MOVE_APP_URL is required}"
fi
if [ "$command" = move ]; then
  : "${SIPGES_MOVE_APP_PASSWORD:?SIPGES_MOVE_APP_PASSWORD is required}"
fi
mkdir -p "$work"
[ -z "$(find "$work" -mindepth 1 -maxdepth 1 -name '*.dump' -print -quit)" ] || [ "$command" != move ] ||
  die "$work already holds a dump: use a new work directory for each move"

here="$(cd "$(dirname "$0")" && pwd)"
secrets="$(mktemp -d)"
restoring=0
# Marks the roles this tool creates as stand-ins, so a retry and `verify` can recognise them.
STAND_IN='sipges-move stand-in'
on_exit() {
  local status=$?
  # A move that failed after creating stand-ins drops them, with any grant they received.
  if [ "$status" != 0 ] && [ "$restoring" = 1 ]; then
    drop_stand_ins || echo "move-postgres: could not drop the stand-in roles; the next move drops them" >&2
  fi
  rm -rf -- "$secrets"
  exit "$status"
}
trap on_exit EXIT
# Every client reads passwords from this file, never from its arguments or PGPASSWORD.
unset PGPASSWORD
export PGPASSFILE="$secrets/pgpass"
: >"$PGPASSFILE"
strip() { node "$here/pg-secrets.mjs" strip "$1" "$PGPASSFILE"; }
SOURCE_URL="$(strip SIPGES_MOVE_SOURCE_URL)" || die "SIPGES_MOVE_SOURCE_URL is not usable"
TARGET_URL="$(strip SIPGES_MOVE_TARGET_URL)" || die "SIPGES_MOVE_TARGET_URL is not usable"
APP_URL=
if [ "$command" != preflight ]; then
  APP_URL="$(strip SIPGES_MOVE_APP_URL)" || die "SIPGES_MOVE_APP_URL is not usable"
fi

# Every source session: read only, whatever the statement.
export PGOPTIONS="-c default_transaction_read_only=on ${PGOPTIONS:-}"
src() { PGOPTIONS="$PGOPTIONS" psql "$SOURCE_URL" -X -q -v ON_ERROR_STOP=1 -v schema="$schema" "$@"; }
# Target sessions must not inherit the read-only option.
tgt() { PGOPTIONS='' psql "$TARGET_URL" -X -q -v ON_ERROR_STOP=1 -v schema="$schema" "$@"; }
app() { PGOPTIONS='' psql "$APP_URL" -X -q -v ON_ERROR_STOP=1 -v schema="$schema" "$@"; }
# A path as one quoted psql argument: a quote inside it is doubled.
quoted() { printf "'%s'" "${1//\'/\'\'}"; }

# The same cluster and database on both sides would restore a database into itself.
refuse_same() {
  local identity="SELECT system_identifier || '/' || current_database() FROM pg_control_system()"
  local source target
  source="$(src -At <<<"$identity")" || die "cannot reach the source"
  target="$(tgt -At <<<"$identity")" || die "cannot reach the target"
  [ "$source" != "$target" ] || die "the target is the source database ($target): refusing"
}

# Drops every role marked as a stand-in, with what it was granted in this database.
drop_stand_ins() {
  local role
  while IFS= read -r role; do
    [ -n "$role" ] || continue
    # DROP OWNED needs the privileges of the role, which its creator may take.
    tgt -v r="$role" <<<'GRANT :"r" TO CURRENT_USER WITH INHERIT TRUE; DROP OWNED BY :"r"; DROP ROLE :"r";' || return 1
    echo "dropped stand-in role: $role"
  done < <(tgt -At -v marker="$STAND_IN" <<<"SELECT rolname FROM pg_roles
    WHERE shobj_description(oid, 'pg_authid') = :'marker' ORDER BY 1")
}

# Text output that is the same on any server: the hashes compare row text.
STABLE="SET TimeZone = 'UTC'; SET DateStyle = 'ISO, MDY'; SET IntervalStyle = 'postgres';
SET extra_float_digits = 1; SET bytea_output = 'hex'; SET row_security = off;"

# Row count and hash of every table, and the state of every sequence. row_security = off makes a
# login that cannot bypass RLS fail here instead of hashing only the rows it can see.
HASHES="$STABLE
SELECT format('SELECT %L, count(*), coalesce(md5(string_agg(h, '''' ORDER BY h COLLATE \"C\")), ''-'')
  FROM (SELECT md5(t::text) AS h FROM %I.%I t) s', 'table ' || c.relname, n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = :'schema' AND c.relkind IN ('r', 'p') ORDER BY c.relname \\gexec
SELECT format('SELECT %L, last_value, is_called FROM %I.%I', 'sequence ' || c.relname, n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = :'schema' AND c.relkind = 'S' ORDER BY c.relname \\gexec"

# Everything that decides behaviour and isolation, with the owner written as OWNER because it
# differs on purpose. Grants compare for PUBLIC, sipges_tenant and the owner only: other grantees
# are the old platform's own roles (Neon's neon_superuser), which the target does not have.
SHAPE="
WITH rel AS (
  SELECT c.oid, c.relname, c.relkind, c.relowner, c.relacl, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c WHERE c.relnamespace = :'schema'::regnamespace
), fn AS (
  SELECT p.oid, p.proowner, p.proacl, p.oid::regprocedure::text AS name, p.prosecdef, p.proconfig,
         md5(pg_get_functiondef(p.oid)) AS body
  FROM pg_proc p WHERE p.pronamespace = :'schema'::regnamespace AND p.prokind IN ('f', 'p')
), who AS (
  SELECT 0::oid AS oid, 'PUBLIC' AS name UNION ALL SELECT oid, rolname FROM pg_roles
), acl AS (
  SELECT 'grant ' || r.relname AS obj, a.grantee, a.privilege_type, a.is_grantable, r.relowner AS owner
  FROM rel r, aclexplode(coalesce(r.relacl, acldefault((CASE WHEN r.relkind = 'S' THEN 's' ELSE 'r' END)::\"char\", r.relowner))) a
  UNION ALL
  SELECT 'grant ' || r.relname || '.' || t.attname, a.grantee, a.privilege_type, a.is_grantable, r.relowner
  FROM rel r JOIN pg_attribute t ON t.attrelid = r.oid AND t.attacl IS NOT NULL, aclexplode(t.attacl) a
  UNION ALL
  SELECT 'grant ' || f.name, a.grantee, a.privilege_type, a.is_grantable, f.proowner
  FROM fn f, aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a
)
SELECT line FROM (
  SELECT format('relation %s kind=%s rls=%s force=%s', relname, relkind, relrowsecurity, relforcerowsecurity) AS line FROM rel
  UNION ALL
  SELECT format('column %s.%s %s notnull=%s generated=%s default=%s', r.relname, t.attname,
    format_type(t.atttypid, t.atttypmod), t.attnotnull, t.attgenerated, pg_get_expr(d.adbin, d.adrelid))
  FROM rel r JOIN pg_attribute t ON t.attrelid = r.oid AND t.attnum > 0 AND NOT t.attisdropped
  LEFT JOIN pg_attrdef d ON d.adrelid = r.oid AND d.adnum = t.attnum
  UNION ALL
  -- A restore re-prints a CHECK with its AND chain flattened, (a AND b) AND c as a AND b AND c, so
  -- CHECK text compares without parentheses. Policies, which carry the isolation, compare exactly.
  SELECT format('constraint %s.%s %s', r.relname, k.conname,
    CASE k.contype WHEN 'c' THEN regexp_replace(pg_get_constraintdef(k.oid), '[()]', '', 'g')
                   ELSE pg_get_constraintdef(k.oid) END)
  FROM rel r JOIN pg_constraint k ON k.conrelid = r.oid
  UNION ALL
  SELECT format('index %s', pg_get_indexdef(i.indexrelid)) FROM rel r JOIN pg_index i ON i.indrelid = r.oid
  UNION ALL
  SELECT format('policy %s.%s cmd=%s permissive=%s roles=%s using=%s check=%s', r.relname, p.polname,
    p.polcmd, p.polpermissive,
    (SELECT string_agg(CASE WHEN x = r.relowner THEN 'OWNER' ELSE coalesce(w.name, x::text) END, ',' ORDER BY 1)
       FROM unnest(p.polroles) x LEFT JOIN who w ON w.oid = x),
    pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid))
  FROM rel r JOIN pg_policy p ON p.polrelid = r.oid
  UNION ALL
  SELECT format('trigger %s.%s enabled=%s %s', r.relname, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid))
  FROM rel r JOIN pg_trigger t ON t.tgrelid = r.oid AND NOT t.tgisinternal
  UNION ALL
  SELECT format('function %s definer=%s config=%s body=%s', name, prosecdef, proconfig, body) FROM fn
  UNION ALL
  SELECT format('%s to %s: %s%s', a.obj, CASE WHEN a.grantee = a.owner THEN 'OWNER' ELSE w.name END,
    a.privilege_type, CASE WHEN a.is_grantable THEN ' with grant option' ELSE '' END)
  FROM acl a JOIN who w ON w.oid = a.grantee
  WHERE a.grantee = a.owner OR w.name IN ('PUBLIC', 'sipges_tenant')
) s ORDER BY line COLLATE \"C\";"

# Roles the dump names that the target lacks: grantees, policy roles, default-privilege owners.
REFERENCED_ROLES="
SELECT DISTINCT r.rolname FROM pg_roles r WHERE r.oid IN (
  SELECT a.grantee FROM pg_class c, aclexplode(c.relacl) a WHERE c.relnamespace = :'schema'::regnamespace
  UNION SELECT a.grantor FROM pg_class c, aclexplode(c.relacl) a WHERE c.relnamespace = :'schema'::regnamespace
  UNION SELECT a.grantee FROM pg_attribute t JOIN pg_class c ON c.oid = t.attrelid, aclexplode(t.attacl) a
        WHERE c.relnamespace = :'schema'::regnamespace
  UNION SELECT a.grantee FROM pg_proc p, aclexplode(p.proacl) a WHERE p.pronamespace = :'schema'::regnamespace
  UNION SELECT a.grantee FROM pg_namespace n, aclexplode(n.nspacl) a WHERE n.nspname = :'schema'
  UNION SELECT x FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid, unnest(p.polroles) x
        WHERE c.relnamespace = :'schema'::regnamespace
  UNION SELECT d.defaclrole FROM pg_default_acl d
  UNION SELECT a.grantee FROM pg_default_acl d, aclexplode(d.defaclacl) a
) ORDER BY 1;"

LOGIN="SELECT current_user || ' super=' || rolsuper || ' bypassrls=' || rolbypassrls || ' createrole=' || rolcreaterole
  || ' server=' || current_setting('server_version_num') FROM pg_roles WHERE rolname = current_user;"

preflight() {
  local client source target tables
  client="$(pg_dump --version | sed -E 's/.* ([0-9]+)\..*/\1/')"
  [ "$(pg_restore --version | sed -E 's/.* ([0-9]+)\..*/\1/')" = "$client" ] || die "pg_dump and pg_restore differ"
  source="$(src -At -c "$LOGIN")" || die "cannot reach the source"
  target="$(tgt -At -c "$LOGIN")" || die "cannot reach the target"
  echo "source login: ${source%% *} (${source#* })"
  echo "target admin: ${target%% *} (${target#* })"
  echo "pg_dump: $client"
  local smajor=$((${source##*server=} / 10000)) tmajor=$((${target##*server=} / 10000))
  [ "$client" -ge "$smajor" ] || die "pg_dump $client is older than the source server ($smajor)"
  [ "$tmajor" -ge "$smajor" ] || die "the target server ($tmajor) is older than the source ($smajor)"
  [[ "$source" == *"super=t"* || "$source" == *"bypassrls=t"* ]] ||
    die "the source login must bypass RLS, or the dump would miss rows"
  [[ "$target" == *"super=t"* || "$target" == *"bypassrls=t"* ]] ||
    die "the target admin must bypass RLS: a forced-RLS table refuses the restore otherwise"
  [[ "$target" == *"super=t"* || "$target" == *"createrole=t"* ]] ||
    die "the target admin must be able to create roles"
  [ "$(src -At -c 'SHOW transaction_read_only')" = on ] || die "the source session is not read only"
  refuse_same
  # An existing sipges_app or sipges_tenant is reused only if it cannot bypass RLS. A
  # non-superuser admin may not even name SUPERUSER in ALTER ROLE, so the tool never alters it.
  local privileged
  privileged="$(tgt -At <<<"SELECT string_agg(rolname, ', ' ORDER BY rolname) FROM pg_roles
    WHERE rolname IN ('sipges_app', 'sipges_tenant') AND (rolsuper OR rolbypassrls)")"
  [ -z "$privileged" ] || die "$privileged exists with SUPERUSER or BYPASSRLS: refusing to reuse it"
  tables="$(tgt -At <<<"SELECT count(*) FROM pg_class WHERE relnamespace = to_regnamespace(:'schema') AND relkind IN ('r','p','S','v','m')")"
  [ "$command" != move ] || [ "$tables" = 0 ] ||
    die "the target schema $schema is not empty ($tables relations): move only into an empty database"
  echo "preflight: ok"
}

# On the source, one REPEATABLE READ transaction exports a snapshot; the hashes, the shape and
# pg_dump all read that same snapshot, so they agree even if something writes meanwhile.
dump_source() {
  coproc SNAP { PGOPTIONS="$PGOPTIONS" psql "$SOURCE_URL" -X -q -At -v ON_ERROR_STOP=1 -v schema="$schema" 2>&1; }
  local snapshot line
  echo "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();" >&"${SNAP[1]}"
  read -r -t 60 snapshot <&"${SNAP[0]}" || die "the source did not export a snapshot"
  [[ "$snapshot" =~ ^[0-9A-F-]+$ ]] || die "the source did not export a snapshot: $snapshot"
  {
    echo "\\o $(quoted "$work/source.hashes")"
    echo "$HASHES"
    echo "\\o $(quoted "$work/source.shape")"
    echo "$SHAPE"
    echo "\\o $(quoted "$work/source.roles")"
    echo "$REFERENCED_ROLES"
    echo "\\o"
    echo "SELECT 'hashed';"
  } >&"${SNAP[1]}"
  read -r -t 3600 line <&"${SNAP[0]}" || die "hashing the source timed out"
  [ "$line" = hashed ] || die "hashing the source failed: $line"
  pg_dump --format=custom --snapshot="$snapshot" --schema="$schema" --no-publications \
    --no-subscriptions --no-security-labels --file="$work/source.dump" "$SOURCE_URL"
  echo "COMMIT;" >&"${SNAP[1]}"
  eval "exec ${SNAP[1]}>&-" # close psql's input: it ends after COMMIT
  wait "$SNAP_PID" || die "the source snapshot session failed"
  echo "dump: $(wc -l <"$work/source.hashes") tables and sequences hashed in snapshot $snapshot"
}

restore_target() {
  local placeholders=() left verifier
  # The roles SIPGES needs. sipges_app gets its password as a SCRAM verifier computed here; an
  # existing one (a retry) keeps its attributes, which preflight proved cannot bypass RLS.
  verifier="$(node "$here/pg-secrets.mjs" scram SIPGES_MOVE_APP_PASSWORD)" ||
    die "SIPGES_MOVE_APP_PASSWORD is not usable"
  SIPGES_APP_VERIFIER="$verifier" tgt <<'SQL'
\getenv app_verifier SIPGES_APP_VERIFIER
SELECT NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sipges_tenant') AS make_tenant,
       NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sipges_app') AS make_app \gset
\if :make_tenant
CREATE ROLE sipges_tenant NOLOGIN NOINHERIT;
\endif
\if :make_app
CREATE ROLE sipges_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'app_verifier';
\else
ALTER ROLE sipges_app WITH LOGIN PASSWORD :'app_verifier';
\endif
GRANT sipges_tenant TO sipges_app WITH ADMIN OPTION;
-- ALTER ... OWNER TO sipges_app needs the admin to be able to become it.
GRANT sipges_app TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
SQL
  # Stand-ins left by a move that could not clean up (killed): their grants must not survive.
  restoring=1
  drop_stand_ins || die "could not drop the stand-in roles of an earlier move"
  # A NOLOGIN stand-in for each other role the dump names (the old platform's own), marked so a
  # retry recognises it, and dropped again after the restore so none of their grants survive.
  while read -r role; do
    [ -n "$role" ] || continue
    if [ "$(tgt -At -v r="$role" <<<"SELECT count(*) FROM pg_roles WHERE rolname = :'r'")" = 0 ]; then
      tgt -v r="$role" -v marker="$STAND_IN" <<<'CREATE ROLE :"r" NOLOGIN; COMMENT ON ROLE :"r" IS :'"'"'marker'"'"';'
      placeholders+=("$role")
    fi
  done <"$work/source.roles"
  echo "stand-in roles: ${placeholders[*]:-none}"
  # Every entry but the schema itself, which the target database already has, and default
  # privileges: no migration sets any, so they are the old platform's (Neon gives its own role
  # every new table), and only a superuser may set them for another role.
  pg_restore --list "$work/source.dump" |
    grep -vE '^[0-9]+; [0-9]+ [0-9]+ (SCHEMA|DEFAULT ACL) ' >"$work/restore.list"
  echo "skipped: $(pg_restore --list "$work/source.dump" | grep -cE '^[0-9]+; [0-9]+ [0-9]+ DEFAULT ACL ') default privileges of the old platform"
  PGOPTIONS='' pg_restore --no-owner --single-transaction --exit-on-error --use-list="$work/restore.list" \
    --dbname="$TARGET_URL" "$work/source.dump"
  # The stand-ins go while the admin still owns everything: a non-superuser's DROP OWNED revokes
  # only grants it made, and after the handover the grantor is sipges_app.
  drop_stand_ins >/dev/null || die "could not drop the stand-in roles"
  restoring=0
  # Hand over everything in the schema, one statement per object: sequences owned by a column
  # follow their table. Functions last, as in production-role-cutover.md. A non-superuser admin
  # may give an object only to a role with CREATE on its schema, so that grant comes first.
  tgt <<'SQL'
SELECT format('GRANT USAGE, CREATE ON SCHEMA %I TO sipges_app', :'schema') \gexec
SELECT format('ALTER %s %s OWNER TO sipges_app',
  CASE c.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,
  c.oid::regclass)
FROM pg_class c
WHERE c.relnamespace = :'schema'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
  AND NOT EXISTS (SELECT FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i') AND d.refobjsubid > 0)
ORDER BY c.relkind DESC, c.relname \gexec
SELECT format('ALTER ROUTINE %s OWNER TO sipges_app', p.oid::regprocedure)
FROM pg_proc p WHERE p.pronamespace = :'schema'::regnamespace AND p.prokind IN ('f', 'p') \gexec
SQL
  left="$(tgt -At <<'SQL'
SELECT (SELECT count(*) FROM pg_class WHERE relnamespace = :'schema'::regnamespace
          AND relowner <> 'sipges_app'::regrole AND relkind IN ('r', 'p', 'v', 'm', 'S'))
     + (SELECT count(*) FROM pg_proc WHERE pronamespace = :'schema'::regnamespace
          AND proowner <> 'sipges_app'::regrole)
SQL
)"
  [ "$left" = 0 ] || die "$left objects in $schema are not owned by sipges_app"
  echo "restore: done, every object in $schema owned by sipges_app"
}

verify() {
  local failed=0
  refuse_same
  if [ ! -s "$work/source.hashes" ]; then
    # verify alone: read the source now.
    src -At <<<"$HASHES" >"$work/source.hashes"
    src -At <<<"$SHAPE" >"$work/source.shape"
  fi
  tgt -At <<<"$HASHES" >"$work/target.hashes"
  tgt -At <<<"$SHAPE" >"$work/target.shape"
  # \o writes psql's default separator; normalize both sides to one space.
  sed -i 's/|/ /g' "$work/source.hashes" "$work/target.hashes"
  if diff -u "$work/source.hashes" "$work/target.hashes" >"$work/hashes.diff"; then
    echo "rows: $(grep -c '^table ' "$work/target.hashes") tables and $(grep -c '^sequence ' "$work/target.hashes") sequences identical"
  else
    echo "rows: DIFFERENT, see $work/hashes.diff" >&2
    failed=1
  fi
  if diff -u "$work/source.shape" "$work/target.shape" >"$work/shape.diff"; then
    echo "shape: $(wc -l <"$work/target.shape") columns, constraints, indexes, policies, triggers, functions and grants identical"
  else
    echo "shape: DIFFERENT, see $work/shape.diff" >&2
    failed=1
  fi
  privilege_audit || failed=1
  rls_proof || failed=1
  [ "$failed" = 0 ] || die "verification FAILED: do not switch to the target"
  echo "verify: ok"
}

# What the shape cannot see: grants on SIPGES objects to roles SIPGES does not use (the shape
# compares PUBLIC, sipges_tenant and the owner only), CREATE on the schema for everyone, default
# privileges for everyone, a SIPGES role that can become a superuser or bypass RLS through
# membership (attributes are never inherited, but SET ROLE reaches them), and stand-ins left over.
PRIVILEGES="
WITH obj AS (
  SELECT 'relation ' || c.relname AS name, c.relacl AS acl FROM pg_class c
  WHERE c.relnamespace = :'schema'::regnamespace AND c.relacl IS NOT NULL
  UNION ALL
  SELECT 'column ' || c.relname || '.' || a.attname, a.attacl FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  WHERE c.relnamespace = :'schema'::regnamespace AND a.attacl IS NOT NULL
  UNION ALL
  SELECT 'routine ' || p.oid::regprocedure::text, p.proacl FROM pg_proc p
  WHERE p.pronamespace = :'schema'::regnamespace AND p.proacl IS NOT NULL
), sipges AS (
  SELECT oid FROM pg_roles WHERE rolname IN ('sipges_app', 'sipges_tenant')
)
SELECT problem FROM (
  SELECT format('%s grants %s to %s', o.name, a.privilege_type, r.rolname) AS problem
  FROM obj o, aclexplode(o.acl) a JOIN pg_roles r ON r.oid = a.grantee
  WHERE r.oid NOT IN (SELECT oid FROM sipges)
  UNION ALL
  SELECT format('schema %s grants %s to %s', n.nspname, a.privilege_type, coalesce(r.rolname, 'PUBLIC'))
  FROM pg_namespace n, aclexplode(n.nspacl) a LEFT JOIN pg_roles r ON r.oid = a.grantee
  WHERE n.nspname = :'schema' AND a.grantee <> n.nspowner AND a.grantee NOT IN (SELECT oid FROM sipges)
    AND NOT (a.grantee = 0 AND a.privilege_type = 'USAGE')
  UNION ALL
  SELECT format('default privileges of %s grant %s on %s to PUBLIC', pg_get_userbyid(d.defaclrole),
    a.privilege_type, d.defaclobjtype)
  FROM pg_default_acl d, aclexplode(d.defaclacl) a
  WHERE a.grantee = 0
    AND NOT (d.defaclobjtype = 'f' AND a.privilege_type = 'EXECUTE')
    AND NOT (d.defaclobjtype = 'T' AND a.privilege_type = 'USAGE')
  UNION ALL
  SELECT format('%s can bypass RLS or is a superuser', s.rolname)
  FROM pg_roles s WHERE s.rolname IN ('sipges_app', 'sipges_tenant') AND (s.rolsuper OR s.rolbypassrls)
  UNION ALL
  SELECT format('%s is a member of %s, which %s', s.rolname, r.rolname,
    CASE WHEN r.rolsuper THEN 'is a superuser' ELSE 'bypasses RLS' END)
  FROM pg_roles s, pg_roles r
  WHERE s.rolname IN ('sipges_app', 'sipges_tenant') AND r.oid <> s.oid
    AND (r.rolsuper OR r.rolbypassrls) AND pg_has_role(s.oid, r.oid, 'MEMBER')
  UNION ALL
  SELECT format('stand-in role %s is left over', r.rolname) FROM pg_roles r
  WHERE shobj_description(r.oid, 'pg_authid') = :'marker'
) p ORDER BY 1;"

privilege_audit() {
  local problems line
  problems="$(tgt -At -v marker="$STAND_IN" <<<"$PRIVILEGES")" ||
    { echo "privileges: the audit failed to run" >&2; return 1; }
  if [ -n "$problems" ]; then
    while IFS= read -r line; do echo "privileges: $line" >&2; done <<<"$problems"
    return 1
  fi
  echo "privileges: ok, nothing granted beyond sipges_app, sipges_tenant and PUBLIC"
}

# Row-level security as the APIs will run: login sipges_app, then each tenant as the request path
# enters it (apps/api-go/internal/platform/database/tenant.go). For every tenant and every table
# the tenant role reads, it must see exactly that tenant's rows and none of another's.
rls_proof() {
  # Called from `verify` as `rls_proof || failed=1`, where bash ignores set -e: every step checks
  # its own status, so an error can never read as a pass.
  local login leaks tenants=() tenant
  login="$(app -At <<<"SELECT current_user || ' ' || rolsuper || ' ' || rolbypassrls FROM pg_roles WHERE rolname = current_user")" ||
    { echo "rls: cannot sign in as sipges_app" >&2; return 1; }
  [ "$login" = "sipges_app false false" ] || { echo "rls: SIPGES_MOVE_APP_URL must be sipges_app without SUPERUSER or BYPASSRLS ($login)" >&2; return 1; }
  # The login itself, with no tenant: forced tables show nothing, though it owns them.
  leaks="$(app -At <<'SQL'
SELECT 'SELECT ' || coalesce(string_agg(format('(SELECT count(*) FROM %s)', c.oid::regclass), ' + '), '0')
FROM pg_class c WHERE c.relnamespace = :'schema'::regnamespace AND c.relkind = 'r' AND c.relforcerowsecurity \gexec
SQL
)" || { echo "rls: the no-tenant check failed to run" >&2; return 1; }
  [ "$leaks" = 0 ] || { echo "rls: sipges_app without a tenant sees $leaks rows of forced tables" >&2; return 1; }
  mapfile -t tenants < <(app -At <<<"SELECT company_id || '/' || project_id FROM tenants ORDER BY 1") &&
    [ "${#tenants[@]}" -gt 0 ] || { echo "rls: no tenants to prove isolation with" >&2; return 1; }
  # Tables the tenant role reads that carry a tenant_id: one line per tenant and table, with the
  # tenant's own rows and the rows of any other tenant. The truth comes from the admin with RLS
  # off; the observation from sipges_app entering the tenant exactly as the APIs do
  # (apps/api-go/internal/platform/database/tenant.go), in a transaction rolled back.
  local count="SELECT format('SELECT %L, %L, count(*) FILTER (WHERE tenant_id = %L), %s FROM %s;',
      :'tenant', c.oid::regclass::text, :'tenant', OTHERS, c.oid::regclass)
    FROM pg_class c
    WHERE c.relnamespace = :'schema'::regnamespace AND c.relkind = 'r' AND c.relrowsecurity
      AND has_table_privilege('sipges_tenant', c.oid, 'SELECT')
      AND EXISTS (SELECT FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
    ORDER BY c.oid::regclass::text"
  local no_others="'0'" others="format('count(*) FILTER (WHERE tenant_id IS DISTINCT FROM %L)', :'tenant')"
  : >"$work/rls.expected"
  : >"$work/rls.actual"
  for tenant in "${tenants[@]}"; do
    tgt -At -v tenant="$tenant" -o "$work/rls.queries" <<<"${count/OTHERS/$no_others}" || return 1
    { echo "SET row_security = off;"; cat "$work/rls.queries"; } |
      tgt -At -F ' ' -v tenant="$tenant" >>"$work/rls.expected" || return 1
    app -At -v tenant="$tenant" -o "$work/rls.queries" <<<"${count/OTHERS/$others}" || return 1
    {
      echo "BEGIN;"
      echo "\\o /dev/null"
      echo "SELECT set_config('app.tenant_id', :'tenant', true), set_config('app.actor', '', true), set_config('app.clearance', 'full', true), set_config('role', 'sipges_tenant', true);"
      echo "\\o"
      cat "$work/rls.queries"
      echo "ROLLBACK;"
    } | app -At -F ' ' -v tenant="$tenant" >>"$work/rls.actual" || return 1
  done
  rm -f "$work/rls.queries"
  local tables rows
  tables="$(cut -d' ' -f2 "$work/rls.expected" | sort -u | wc -l)"
  rows="$(awk '{n += $(NF-1)} END {print n + 0}' "$work/rls.expected")"
  [ "$tables" -gt 0 ] && [ "$rows" -gt 0 ] || { echo "rls: no tenant rows to prove isolation with" >&2; return 1; }
  if diff -u "$work/rls.expected" "$work/rls.actual" >"$work/rls.diff"; then
    echo "rls: ${#tenants[@]} tenants x $tables tables, $rows tenant rows, each seen only by its own tenant as sipges_app"
  else
    echo "rls: DIFFERENT, see $work/rls.diff (last column: rows of another tenant)" >&2
    return 1
  fi
}

case "$command" in
  preflight) preflight ;;
  move)
    preflight
    dump_source
    restore_target
    verify
    ;;
  verify)
    rm -f "$work/source.hashes" "$work/source.shape"
    verify
    ;;
esac
