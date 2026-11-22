#!/bin/bash
# The off-site copy of the sealed backups (world-class-local T13), run by the offsite service with
# rclone. The backups are already encrypted with SIPGES_BACKUP_PASSPHRASE, so the remote only ever
# holds ciphertext. A backup on the remote counts only once its SHA256SUMS is there: the data files
# go up first, are checked, and the checksums go up last.
#   bash offsite.sh loop          push now, then every hour (the service)
#   bash offsite.sh push          one round: push what the remote lacks, then apply retention
#   bash offsite.sh list          the backups on the remote, oldest first
#   bash offsite.sh fetch <name>  bring one back into the backups folder, checked
#   bash offsite.sh probe         write, read and remove a file, to prove the remote works
# SIPGES_BACKUP_OFFSITE names the rclone remote and folder (nas:sipges). The container path is
# /backups; SIPGES_BACKUPS_PATH changes it for the tests. It runs as the installing user, so what it
# writes stays theirs.
set -Euo pipefail # no -e: every failure below is handled and recorded
umask 077

backups=${SIPGES_BACKUPS_PATH:-/backups}
remote=${SIPGES_BACKUP_OFFSITE:-}
keep=${SIPGES_BACKUP_KEEP:-14}
name_re='^20[0-9]{6}T[0-9]{6}Z$'
[[ -n $remote ]] || {
  echo 'SIPGES_BACKUP_OFFSITE is not set' >&2
  exit 1
}
[[ $keep =~ ^[1-9][0-9]*$ ]] || {
  echo 'SIPGES_BACKUP_KEEP must be 1 or more' >&2
  exit 1
}

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

failed() {
  printf '%s %s\n' "$(now)" "$1" >"$backups/.last-offsite-failure"
  echo "off-site push failed: $1" >&2
  return 1
}

# The files on the remote, two levels down. Every decision below reads one listing taken here, with
# its status checked: a second listing that failed unseen would make every backup look half pushed.
listing() { rclone lsf -R --files-only --max-depth=2 "$remote"; }

# From a listing: the backups with their checksums, oldest first. Anything else is left alone.
complete_in() { sed -nE 's#^(20[0-9]{6}T[0-9]{6}Z)/SHA256SUMS$#\1#p' <<<"$1" | sort; }

# From a listing: folders named like a backup that never got their checksums, pushes cut short.
incomplete_in() {
  comm -23 <(sed -nE 's#^(20[0-9]{6}T[0-9]{6}Z)/.*#\1#p' <<<"$1" | sort -u) <(complete_in "$1")
}

local_backups() {
  find "$backups" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended \
    -regex '.*/20[0-9]{6}T[0-9]{6}Z' -printf '%f\n' | sort
}

push_one() {
  local name=$1
  rclone copy --exclude=/SHA256SUMS "$backups/$name" "$remote/$name" &&
    rclone check --one-way --exclude=/SHA256SUMS "$backups/$name" "$remote/$name" &&
    rclone copyto "$backups/$name/SHA256SUMS" "$remote/$name/SHA256SUMS"
}

push() {
  rclone mkdir "$remote" || {
    failed "cannot reach $remote"
    return 1
  }
  local files newest todo name old
  files=$(listing) || {
    failed "cannot reach $remote"
    return 1
  }
  newest=$(complete_in "$files" | tail -n 1)
  # A first push sends only the newest backup; after that, every one newer than the remote's newest,
  # so a computer that was off for days catches up without sending what retention would drop.
  if [[ -z $newest ]]; then
    todo=$(local_backups | tail -n 1)
  else
    todo=$(local_backups | awk -v newest="$newest" '$0 > newest')
  fi
  for name in $todo; do
    push_one "$name" || {
      failed "could not push $name to $remote"
      return 1
    }
    echo "pushed $name to $remote"
  done

  # A fresh listing after the pushes; if it fails, nothing is removed.
  files=$(listing) || {
    failed "pushed, but could not list $remote to apply retention"
    return 1
  }
  # Retention as for the backups (ops/retain.sh), on the backups the remote holds.
  complete_in "$files" | bash "$(dirname "${BASH_SOURCE[0]}")/retain.sh" "$keep" "${SIPGES_BACKUP_KEEP_WEEKLY:-8}" "${SIPGES_BACKUP_KEEP_MONTHLY:-12}" |
    while read -r old; do
      rclone purge "$remote/${old:?}" || exit 1
    done || {
    failed "pushed, but could not remove older backups from $remote"
    return 1
  }
  # Every push that remains unfinished has been retried above, so these are gone from here.
  incomplete_in "$files" | while read -r old; do
    rclone purge "$remote/${old:?}" || exit 1
  done || {
    failed "could not remove half pushed backups from $remote"
    return 1
  }

  # Retention always keeps the newest (SIPGES_BACKUP_KEEP is 1 or more).
  newest=$(complete_in "$files" | tail -n 1)
  printf '%s %s\n' "$(now)" "$newest" >"$backups/.last-offsite"
  rm -f -- "$backups/.last-offsite-failure"
}

fetch() {
  local name=${1:-} partial
  [[ $name =~ $name_re ]] || {
    echo "\"$name\" is not a backup name" >&2
    return 1
  }
  [[ ! -e $backups/$name ]] || {
    echo "$name is already in the backups folder" >&2
    return 1
  }
  partial="$backups/.partial-fetch-$name"
  rm -rf -- "$partial"
  if ! rclone copy "$remote/$name" "$partial" || [[ ! -f $partial/SHA256SUMS ]] ||
    ! (cd "$partial" && sha256sum --quiet -c SHA256SUMS); then
    rm -rf -- "$partial"
    echo "could not fetch $name from $remote, or it does not match its checksums" >&2
    return 1
  fi
  mv -T -- "$partial" "$backups/$name"
  echo "fetched $name from $remote"
}

probe() {
  local file="$remote/.sipges-offsite-probe" token
  token=$(date +%s%N)
  rclone mkdir "$remote" &&
    printf '%s' "$token" | rclone rcat "$file" &&
    [[ $(rclone cat "$file") == "$token" ]] &&
    rclone deletefile "$file"
}

case ${1:-} in
push) push ;;
list) files=$(listing) && complete_in "$files" ;;
fetch) fetch "${2:-}" ;;
probe) probe ;;
loop)
  while true; do
    push || true
    sleep 3600 &
    wait $!
  done
  ;;
*)
  echo 'usage: offsite.sh loop | push | list | fetch <name> | probe' >&2
  exit 2
  ;;
esac
