#!/bin/bash
# The copy of one finished backup on a second disk (local-qa-findings T15), run by backup.sh once
# the backup counts. It never fails the backup: a copy that cannot be made is written to
# .last-copy-failure, which ./sipges status shows, and the script still ends with 0.
#   bash copy.sh <backup name>
# SIPGES_BACKUP_COPY names the host folder (empty: no copy). The container paths are /backups and
# /backup-copy; SIPGES_BACKUPS_PATH and SIPGES_COPY_PATH change them for the tests.
set -Euo pipefail # no -e: every failure below is handled and recorded
umask 077

name=$1
backups=${SIPGES_BACKUPS_PATH:-/backups}
copy=${SIPGES_COPY_PATH:-/backup-copy}
keep=${SIPGES_BACKUP_KEEP:-14}
[[ -n ${SIPGES_BACKUP_COPY:-} ]] || exit 0

failed() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >"$backups/.last-copy-failure"
  chown "${SIPGES_HOST_OWNER:-}" "$backups/.last-copy-failure" 2>/dev/null || true
  echo "backup copy skipped: $1" >&2
  exit 0
}

# Only a folder ./sipges copy-backups-to marked: with the disk unplugged, Docker mounts an empty
# folder of this disk in its place, and a container keeps the mount it started with, so a disk
# plugged back in shows only after ./sipges start.
[[ -f $copy/.sipges-backup-copy ]] ||
  failed "$SIPGES_BACKUP_COPY is not marked as the copy: is the disk plugged in? Then run ./sipges start"

# A copy cut short (power, a pulled disk) leaves its partial; a day is far longer than a copy.
find "$copy" -mindepth 1 -maxdepth 1 -type d -name '.partial-*' -mmin +1440 -exec rm -rf -- {} + 2>/dev/null
partial="$copy/.partial-$name"
rm -rf -- "$partial"
if ! cp -r -- "$backups/$name" "$partial" || ! (cd "$partial" && sha256sum --quiet -c SHA256SUMS) ||
  ! mv -T -- "$partial" "$copy/$name"; then
  rm -rf -- "$partial"
  failed "could not copy $name to $SIPGES_BACKUP_COPY"
fi
# Disks such as FAT keep no owner: then the copy stays as written.
chown -R "${SIPGES_HOST_OWNER:-}" "$copy/$name" 2>/dev/null || true

# Retention as for the backups, on folders named exactly like one (20261119T070000Z), so nothing
# else on that disk is touched. The new copy is set aside first.
prune() {
  local old
  find "$copy" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended \
    -regex '.*/20[0-9]{6}T[0-9]{6}Z' ! -name "$name" -printf '%f\n' | sort -r | tail -n "+$keep" |
    while read -r old; do
      rm -rf -- "${copy:?}/${old:?}" || return 1
    done
}
prune || failed "copied $name, but could not remove older copies in $SIPGES_BACKUP_COPY"
rm -f -- "$backups/.last-copy-failure"
echo "backup copied to $SIPGES_BACKUP_COPY"
