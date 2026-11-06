#!/bin/bash
# Restores one backup into the stopped installation. It decrypts and loads into a new database and
# a new folder first: a wrong passphrase or a damaged file stops there, with the data untouched.
# Then one transaction swaps the databases, and the files follow. What it replaces stays as the
# database sipges_before_restore and the folder .before-restore until the next restore.
#
# Exit codes, which ./sipges reads:
#   0  restored
#   1  stopped before the swap, and no earlier restore is unfinished: nothing changed
#   3  a restore is unfinished, this one or an earlier one: only finishing it brings SIPGES back
set -Eeuo pipefail
# shellcheck source=deploy/local/ops/crypto.sh
source /ops/crypto.sh

name=${1:?usage: restore.sh <backup name>}
source_dir="/backups/$name"
upload_root=/data/uploads
incoming="$upload_root/.restoring"
replaced="$upload_root/.before-restore"
# Stored on the new database in the swap's transaction, cleared last: while it is there, a restore
# is unfinished, and another run must not take the restored database for the one to keep.
marker="sipges-restore:$name"
swapping=0

finish() {
  local status=$?
  rm -rf -- "$GNUPGHOME" "$incoming"
  if ((status != 0)); then
    exit $((swapping ? 3 : 1))
  fi
}
trap finish EXIT
trap 'exit 143' TERM INT

sql_value() { psql --no-psqlrc -qtA -v ON_ERROR_STOP=1 -c "$1"; }

pending=$(sql_value "SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = 'sipges'")
if [[ $pending == sipges-restore:* ]]; then
  swapping=1
fi
if [[ $pending == sipges-restore:* && $pending != "$marker" ]]; then
  echo "the restore of ${pending#sipges-restore:} did not finish: run that one again first" >&2
  exit 1
fi

[[ -d $source_dir ]] || { echo "no backup named $name" >&2; exit 1; }
(cd "$source_dir" && sha256sum --quiet --check SHA256SUMS)

if [[ $pending != "$marker" ]]; then
  psql --no-psqlrc -q -v ON_ERROR_STOP=1 <<'SQL'
DROP DATABASE IF EXISTS sipges_restoring;
CREATE DATABASE sipges_restoring OWNER sipges_app TEMPLATE template0;
SQL
  open_sealed "$source_dir/db.dump.gpg" |
    pg_restore --no-password --dbname=sipges_restoring --exit-on-error --single-transaction
fi

rm -rf -- "$incoming"
mkdir "$incoming"
open_sealed "$source_dir/uploads.tar.gpg" | tar -C "$incoming" -xf -

swapping=1
if [[ $pending != "$marker" ]]; then
  rm -rf -- "$replaced"
  psql --no-psqlrc -q -v ON_ERROR_STOP=1 -v marker="$marker" <<'SQL'
REVOKE ALL ON DATABASE sipges_restoring FROM PUBLIC;
GRANT CONNECT ON DATABASE sipges_restoring TO sipges_backup;
COMMENT ON DATABASE sipges_restoring IS :'marker';
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
  WHERE datname = 'sipges' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS sipges_before_restore;
BEGIN;
ALTER DATABASE sipges RENAME TO sipges_before_restore;
ALTER DATABASE sipges_restoring RENAME TO sipges;
COMMIT;
SQL
fi

# .complete says every old file is set aside. Without it a rerun goes on moving them; with it,
# whatever is at the top is an earlier run's restored files, and the fresh copy replaces them.
mkdir -p "$replaced"
if [[ ! -e $replaced/.complete ]]; then
  find "$upload_root" -mindepth 1 -maxdepth 1 ! -name .restoring ! -name .before-restore \
    -exec mv -t "$replaced" -- {} +
  touch "$replaced/.complete"
else
  find "$upload_root" -mindepth 1 -maxdepth 1 ! -name .restoring ! -name .before-restore \
    -exec rm -rf -- {} +
fi
# The drill's way to stop at the two worst moments: before and after the files are back.
[[ ${SIPGES_DRILL_STOP_AFTER_SWAP:-} != before-files ]] || exit 1
find "$incoming" -mindepth 1 -maxdepth 1 -exec mv -t "$upload_root" -- {} +
[[ ${SIPGES_DRILL_STOP_AFTER_SWAP:-} != after-files ]] || exit 1
chown -R 65532:65532 "$upload_root"
sql_value 'COMMENT ON DATABASE sipges IS NULL' >/dev/null
echo "restore finished: $name"
