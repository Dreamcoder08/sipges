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

# `bash schedule.sh --next HOUR` prints the wait, so a test can check the arithmetic.
if [[ ${1:-} == --next ]]; then
  seconds_until "$2"
  exit 0
fi

while true; do
  wait_seconds=$(seconds_until "${SIPGES_BACKUP_HOUR:-2}")
  echo "next backup in $wait_seconds seconds"
  sleep "$wait_seconds" &
  wait $!
  if ! bash /ops/backup.sh; then
    date -u +%Y-%m-%dT%H:%M:%SZ >/backups/.last-failure
    chown "$SIPGES_HOST_OWNER" /backups/.last-failure
    echo "backup failed" >&2
  fi
done
