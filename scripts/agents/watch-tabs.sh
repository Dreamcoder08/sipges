#!/usr/bin/env bash
# Watches the Herdr agent tabs of a parallel run (skill sipges-parallel-agents) and prints one line
# per event the orchestrator must act on:
#   BLOCKED <tab> <where>   the agent waits on a native permission or question prompt
#   CONSENT <tab> <where>   the agent printed a text-mode consent prompt ("Respondé con 1, 2 …")
#   DONE <tab> <where>      the agent finished; read its report, then close the tab to free memory
#   MERGED #<n> <title>     a pull request merged since the last pass (seen numbers in the state file)
# It only reads: it never answers a prompt, closes a tab or merges anything.
# Needs hc (Herdr), gh and jq. No credentials are read or printed.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/agents/watch-tabs.sh [--once] [--interval SECONDS] [--until EVENT]
       scripts/agents/watch-tabs.sh --status
  --once       one pass, then exit (default: repeat every --interval seconds, 60)
  --until      keep passing and exit after the first pass that prints EVENT, for Monitor
  --status     print address, status and place of every live agent tab, then exit
  WATCH_TABS_STATE  file of merged PR numbers already reported
                    (default: ${XDG_STATE_HOME:-$HOME/.local/state}/sipges/watch-tabs-merged)
EOF
}

once=0
interval=60
until_event=''
show_status=0
while [ $# -gt 0 ]; do
  case "$1" in
    --once) once=1 ;;
    --status) show_status=1 ;;
    --until)
      until_event="${2:?--until needs BLOCKED, CONSENT, DONE or MERGED}"
      shift
      ;;
    --interval)
      interval="${2:?--interval needs a number of seconds}"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [ "$once" -eq 1 ] && [ -n "$until_event" ]; then
  usage >&2
  exit 2
fi

if [ "$show_status" -eq 1 ]; then
  hc ls --json | jq -r '.terminals[]
    | select(.state == "live" and (.agent // "") != "")
    | [.address, .status, .where] | @tsv'
  exit 0
fi

state="${WATCH_TABS_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/sipges/watch-tabs-merged}"
mkdir -p "$(dirname "$state")"
touch "$state"

# Text consent prompts the Gentle AI review prints when it cannot open a native question.
consent_pattern='Respond[eé] con [0-9]|Respond with [0-9]|Reply with [0-9]'

pass() {
  local tabs address status where
  tabs="$(hc ls --json)"
  while IFS=$'\t' read -r address status where; do
    [ -n "$address" ] || continue
    case "$status" in
      blocked) echo "BLOCKED $address $where" ;;
      working) ;;
      *)
        if hc read "$address" --lines 40 2>/dev/null | grep -Eq "$consent_pattern"; then
          echo "CONSENT $address $where"
        elif [ "$status" = "done" ]; then
          echo "DONE $address $where"
        fi
        ;;
    esac
  done < <(printf '%s' "$tabs" | jq -r '.terminals[]
    | select(.state == "live" and (.agent // "") != "")
    | [.address, .status, .where] | @tsv')

  local number title
  while read -r number title; do
    [ -n "$number" ] || continue
    if ! grep -qx "$number" "$state"; then
      echo "MERGED #$number $title"
      echo "$number" >>"$state"
    fi
  done < <(gh pr list --state merged --limit 20 --json number,title \
    --jq '.[] | "\(.number) \(.title)"' | sort -n)
}

while :; do
  events="$(pass)"
  [ -z "$events" ] || printf '%s\n' "$events"
  [ "$once" -eq 1 ] && break
  if [ -n "$until_event" ] && printf '%s\n' "$events" | grep -q "^$until_event "; then
    break
  fi
  sleep "$interval"
done
