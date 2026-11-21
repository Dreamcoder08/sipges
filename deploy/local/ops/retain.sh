#!/bin/bash
# Calendar retention (world-class-local T2): which backups to remove.
#   retain.sh NEWEST WEEKLY MONTHLY < names
# Reads backup names (20261121T070000Z, one per line), ignores anything else, and prints the ones to
# remove. Kept: the NEWEST most recent backups, as before, plus the newest backup of each of the last
# WEEKLY ISO weeks and of each of the last MONTHLY months, which keep restore points up to a year
# back without keeping every night.
set -Eeuo pipefail

newest=$1 weekly=$2 monthly=$3
for n in "$newest" "$weekly" "$monthly"; do
  [[ $n =~ ^[0-9]+$ ]] || {
    echo "retain.sh: $n is not a count" >&2
    exit 1
  }
done

declare -A weeks=() months=()
index=0
while read -r name; do
  [[ $name =~ ^(20[0-9]{2})([0-9]{2})([0-9]{2})T[0-9]{6}Z$ ]] || continue
  week=$(date -u -d "${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]}" +%G%V)
  month=${name:0:6}
  keep=no
  ((index >= newest)) || keep=yes
  index=$((index + 1))
  # The first name seen of a week or month is its newest backup, whether kept by count or not.
  if [[ -z ${weeks[$week]:-} ]] && ((${#weeks[@]} < weekly)); then
    weeks[$week]=1
    keep=yes
  fi
  if [[ -z ${months[$month]:-} ]] && ((${#months[@]} < monthly)); then
    months[$month]=1
    keep=yes
  fi
  [[ $keep == yes ]] || printf '%s\n' "$name"
done < <(grep -E '^20[0-9]{6}T[0-9]{6}Z$' | sort -r)
