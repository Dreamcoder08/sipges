#!/bin/bash
# The nightly backup. A failure is written where `./sipges status` shows it, and the loop goes on:
# one bad night must not end the next ones.
set -Eeuo pipefail

# Seconds from now to the next HOUR:00 in the container's time zone, always above zero.
seconds_until() {
  local hour=$1 now target
  now=$(date +%s)
  target=$(date -d "today $hour:00" +%s)
  if ((target <= now)); then
    target=$(date -d "tomorrow $hour:00" +%s)
  fi
  echo $((target - now))
}

# Yes when no finished backup is under a day old: a laptop off or asleep at the backup hour gets
# its backup as soon as SIPGES starts again (world-class-local T2).
backups=${SIPGES_BACKUPS_PATH:-/backups}
due() {
  if [[ -n $(find "$backups" -mindepth 1 -maxdepth 1 -type d -name '20*Z' -mmin -1440 -print -quit 2>/dev/null) ]]; then
    echo no
  else
    echo yes
  fi
}

# `bash schedule.sh --next HOUR` prints the wait and `--due` whether a backup is owed, so a test
# can check both.
if [[ ${1:-} == --next ]]; then
  seconds_until "$2"
  exit 0
fi
if [[ ${1:-} == --due ]]; then
  due
  exit 0
fi

run_backup() {
  if ! bash /ops/backup.sh; then
    date -u +%Y-%m-%dT%H:%M:%SZ >/backups/.last-failure
    chown "$SIPGES_HOST_OWNER" /backups/.last-failure
    echo "backup failed" >&2
  fi
}

if [[ $(due) == yes ]]; then
  echo 'no backup in the last day: backing up now'
  run_backup
fi

while true; do
  wait_seconds=$(seconds_until "${SIPGES_BACKUP_HOUR:-2}")
  echo "next backup in $wait_seconds seconds"
  sleep "$wait_seconds" &
  wait $!
  run_backup
done
