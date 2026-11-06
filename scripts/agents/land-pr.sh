#!/usr/bin/env bash
# Lands one pull request: the land step of skill sipges-task-pr. Without --merge it only waits for the
# checks and reports; merging, and the deployment a merge triggers, stay the owner's decision.
#   READY #<n>             checks green and no conflict; nothing merged
#   CONFLICT #<n> <state>  merge origin/main locally first (exit 3)
#   CHECKS_FAILED #<n>     use sipges-ci-triage (exit 4)
#   MERGED #<n> <sha>      merged with a merge commit
#   DEPLOYED #<n> <run>    Deploy Workers for that commit succeeded
#   DEPLOY_FAILED #<n> <run> <conclusion>  it failed or was skipped (exit 5)
#   NO_DEPLOY #<n> <sha>   no run for that commit; a docs-only merge starts none, so check which (exit 6)
# Needs gh and jq. No credentials are read or printed.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/agents/land-pr.sh <pr-number> [--merge]
  --merge  merge when green, then wait for Deploy Workers. Only with the owner's authorization.
  LAND_PR_POLL      seconds between polls (default 15)
  LAND_PR_ATTEMPTS  polls before giving up (default 80)
EOF
}

pr=''
merge=0
while [ $# -gt 0 ]; do
  case "$1" in
    --merge) merge=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *[!0-9]* | '')
      usage >&2
      exit 2
      ;;
    *) pr="$1" ;;
  esac
  shift
done
[ -n "$pr" ] || {
  usage >&2
  exit 2
}

poll="${LAND_PR_POLL:-15}"
attempts="${LAND_PR_ATTEMPTS:-80}"

conflicts() {
  local state
  state="$(gh pr view "$pr" --json mergeable,mergeStateStatus --jq '.mergeable + " " + .mergeStateStatus')"
  case "$state" in
    CONFLICTING* | *DIRTY)
      echo "CONFLICT #$pr $state"
      exit 3
      ;;
  esac
}

conflicts
gh pr checks "$pr" --watch >/dev/null 2>&1 || {
  echo "CHECKS_FAILED #$pr"
  exit 4
}
conflicts
if [ "$merge" -eq 0 ]; then
  echo "READY #$pr"
  exit 0
fi

[ "$(gh pr view "$pr" --json isDraft --jq .isDraft)" != "true" ] || gh pr ready "$pr" >/dev/null
gh pr merge "$pr" --merge >/dev/null

sha=''
for ((i = 0; i < attempts; i++)); do
  sha="$(gh pr view "$pr" --json state,mergeCommit --jq 'select(.state == "MERGED") | .mergeCommit.oid')"
  [ -n "$sha" ] && break
  sleep "$poll"
done
[ -n "$sha" ] || {
  echo "CHECKS_FAILED #$pr merge did not complete"
  exit 4
}
echo "MERGED #$pr $sha"

run=''
for ((i = 0; i < attempts; i++)); do
  run="$(gh run list --workflow deploy-workers.yml --branch main --limit 20 --json databaseId,headSha \
    --jq "map(select(.headSha == \"$sha\")) | .[0].databaseId // empty")"
  [ -n "$run" ] && break
  sleep "$poll"
done
[ -n "$run" ] || {
  echo "NO_DEPLOY #$pr $sha"
  exit 6
}
gh run watch "$run" >/dev/null 2>&1 || true
conclusion="$(gh run view "$run" --json conclusion --jq .conclusion)"
[ "$conclusion" = "success" ] || {
  echo "DEPLOY_FAILED #$pr $run $conclusion"
  exit 5
}
echo "DEPLOYED #$pr $run"
