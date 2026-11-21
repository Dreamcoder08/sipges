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

# The loop wakes at least every hour: a laptop asleep at the backup hour keeps this container
# running, so only a check on waking finds the backup it owes.
nap() {
  local wait_seconds
  wait_seconds=$(seconds_until "$1")
  echo $((wait_seconds < 3600 ? wait_seconds : 3600))
}

# `bash schedule.sh --next HOUR`, `--nap HOUR` and `--due` print the wait to the backup hour, the
# next sleep and whether a backup is owed, so a test can check them.
if [[ ${1:-} == --next ]]; then
  seconds_until "$2"
  exit 0
fi
if [[ ${1:-} == --nap ]]; then
  nap "$2"
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
  hour=${SIPGES_BACKUP_HOUR:-2}
  wait_seconds=$(seconds_until "$hour")
  sleep_seconds=$(nap "$hour")
  echo "next backup in $wait_seconds seconds"
  sleep "$sleep_seconds" &
  wait $!
  # The backup hour, or a wake-up with no backup in the last day.
  if ((sleep_seconds == wait_seconds)) || [[ $(due) == yes ]]; then
    run_backup
  fi
done
