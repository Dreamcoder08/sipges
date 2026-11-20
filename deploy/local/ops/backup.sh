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

# The copy on a second disk (local-qa-findings T15). It never fails the backup: a copy that cannot
# be made is written where ./sipges status shows it. It goes only into a folder ./sipges
# copy-backups-to marked, so an unplugged disk, for which Docker mounts an empty folder of this
# disk instead, gets nothing; it counts only once its checksums match.
copy_failed() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >/backups/.last-copy-failure
  chown "$SIPGES_HOST_OWNER" /backups/.last-copy-failure
  echo "backup copy skipped: $1" >&2
}
copy_out() {
  local copy=/backup-copy partial
  [[ -n ${SIPGES_BACKUP_COPY:-} ]] || return 0
  if [[ ! -f $copy/.sipges-backup-copy ]]; then
    copy_failed "$SIPGES_BACKUP_COPY is not marked as the copy (is the disk plugged in?)"
    return 0
  fi
  partial="$copy/.partial-$stamp"
  rm -rf -- "$partial"
  if ! cp -r -- "$final" "$partial" || ! (cd "$partial" && sha256sum --quiet -c SHA256SUMS) ||
    ! mv -T -- "$partial" "$copy/$stamp"; then
    rm -rf -- "$partial"
    copy_failed "could not copy $stamp to $SIPGES_BACKUP_COPY"
    return 0
  fi
  # Disks such as FAT keep no owner: then the copy simply stays as written.
  chown -R "$SIPGES_HOST_OWNER" "$copy/$stamp" 2>/dev/null || true
  find "$copy" -mindepth 1 -maxdepth 1 -type d -name '20*Z' ! -name "$stamp" -printf '%f\n' | sort -r |
    tail -n "+$keep" | while read -r old; do
    rm -rf -- "$copy/${old:?}"
  done
  rm -f /backups/.last-copy-failure
  echo "backup copied to $SIPGES_BACKUP_COPY"
}
copy_out
