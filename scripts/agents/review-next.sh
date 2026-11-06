#!/usr/bin/env bash
# Prints what a `gentle-ai review ... --json` result asks for next, from stdin. It only reads: it never
# runs the command, and never rebuilds it, because provider tokens must be executed exactly as issued.
# Exit 3 means a consent envelope: relay it to the owner losslessly and wait.
set -euo pipefail

if [ $# -gt 0 ]; then
  echo 'Usage: gentle-ai review ... --json | scripts/agents/review-next.sh' >&2
  exit 2
fi

input="$(cat)"
schema="$(printf '%s' "$input" | jq -r '.schema // ""')"
if [ "$schema" = "gentle-ai.review-integration.consent/v3" ]; then
  echo 'CONSENT relay this envelope to the owner; never answer it'
  exit 3
fi
printf '%s' "$input" | jq -r '
  (.next_transition // {}) as $next
  | [
      (if has("risk") then "risk=\(.risk) review_due=\(.review_due) reason=\(.review_due_reason)" else empty end),
      "transition=\($next.action // $next.kind // "none") operation=\($next.operation // "none")",
      (($next.reason_code // .reason_code) | if . then "reason_code=\(.)" else empty end),
      ($next.command | if . then "command=\(.)" else empty end)
    ]
  | .[]'
