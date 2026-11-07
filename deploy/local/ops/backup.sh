#!/bin/bash
# One backup: the database, then the evidence files, each encrypted before it touches the disk.
# In that order a row can never point at a file the backup lacks. A backup appears under its final
# name only after it has been read back, and older ones are removed only after that.
set -Eeuo pipefail
umask 077
# shellcheck source=deploy/local/ops/crypto.sh
source /ops/crypto.sh

keep=${SIPGES_BACKUP_KEEP:-14}
if [[ ! $keep =~ ^[1-9][0-9]*$ ]]; then
  echo 'SIPGES_BACKUP_KEEP must be 1 or more' >&2
  exit 1
fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
partial="/backups/.partial-$stamp"
final="/backups/$stamp"
trap 'rm -rf -- "$partial" "$GNUPGHOME"' EXIT
# A power cut leaves its partial behind; a day is far longer than any backup runs.
find /backups -mindepth 1 -maxdepth 1 -type d -name '.partial-*' -mmin +1440 -exec rm -rf -- {} +
mkdir "$partial"

# tar exits 1 when a file changes as it is read: evidence uploaded during the backup, which no row
# in the dump points at yet. Anything above 1 is a real failure.
archive_uploads() {
  local status=0
  tar -C /data/uploads --exclude=./.restoring --exclude=./.before-restore \
    --warning=no-file-changed -cf - . || status=$?
  ((status <= 1))
}

pg_dump --format=custom --no-password | seal >"$partial/db.dump.gpg"
archive_uploads | seal >"$partial/uploads.tar.gpg"
(cd "$partial" && sha256sum db.dump.gpg uploads.tar.gpg >SHA256SUMS)

# Reads every data block: --list stops at the table of contents, which closes the pipe on gpg
# as soon as the dump outgrows it, and proves nothing about the data.
open_sealed "$partial/db.dump.gpg" | pg_restore --file=/dev/null
open_sealed "$partial/uploads.tar.gpg" | tar -tf - >/dev/null

chown -R "$SIPGES_HOST_OWNER" "$partial"
mv -T "$partial" "$final"

# The one just written is set aside first, so a clock that moved back cannot sort it out of the
# kept set. Only finished backups match the name.
find /backups -mindepth 1 -maxdepth 1 -type d -name '20*Z' ! -name "$stamp" -printf '%f\n' | sort -r |
  tail -n "+$keep" | while read -r old; do
  rm -rf -- "/backups/${old:?}"
done
rm -f /backups/.last-failure
echo "backup finished: $stamp"
