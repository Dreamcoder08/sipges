#!/usr/bin/env bash
# Lands one pull request: the land step of skill sipges-task-pr. Without --merge it only waits for the
# checks and reports; merging, and the deployment a merge triggers, stay the owner's decision.
#   READY #<n>             checks green and no conflict; nothing merged
#   CONFLICT #<n> <state>  merge origin/main locally first (exit 3)
#   CHECKS_FAILED #<n>     use sipges-ci-triage (exit 4)
#   MERGED #<n> <sha>      merged with a merge commit, and its head is an ancestor of origin/main
#   DEPLOYED #<n> <run>    Deploy Workers for that commit succeeded
#   DEPLOY_SUPERSEDED #<n> <run> <sha>  a newer merge took over; its deploy decides
#   DEPLOY_FAILED #<n> <run> <conclusion>  it failed, or CI did and skipped it (exit 5)
#   NO_DEPLOY #<n> <sha>   no run for that commit; a docs-only merge starts none, so check which (exit 6)
# Exit 7 means the answer is unknown, never that it failed. Nothing was merged for the first three,
# and running the script again resumes safely:
#   UNKNOWN_STATE #<n> <state>  GitHub never computed the merge state
#   CHECKS_PENDING #<n>         checks still running after the last poll
#   MERGE_UNCONFIRMED #<n> <head>  the repository does not show the merge
#   DEPLOY_UNKNOWN #<n> <run>   merged, but the deploy has no conclusion yet
# Needs gh, git and jq. No credentials are read or printed.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/agents/land-pr.sh <pr-number> [--merge [--no-deploy-wait]]
  --merge           merge when green, then wait for Deploy Workers. Only with the owner's authorization.
  --no-deploy-wait  stop after MERGED; for merges in a row, where only the last deploy runs.
  LAND_PR_POLL      seconds between polls (default 15)
  LAND_PR_ATTEMPTS  polls before giving up (default 80)
EOF
}

pr=''
merge=0
wait_deploy=1
while [ $# -gt 0 ]; do
  case "$1" in
    --merge) merge=1 ;;
    --no-deploy-wait) wait_deploy=0 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *[!0-9]* | '')
      usage >&2
      exit 2
      ;;
    *)
      [ -z "$pr" ] || {
        usage >&2
        exit 2
      }
      pr="$1"
      ;;
  esac
  shift
done
[ -n "$pr" ] || {
  usage >&2
  exit 2
}

poll="${LAND_PR_POLL:-15}"
attempts="${LAND_PR_ATTEMPTS:-80}"

# GitHub answers 502 under load, so a failed read means "ask again", never a result.
gh_read() {
  local i out
  for ((i = 0; i < 3; i++)); do
    if out="$(gh "$@" 2>/dev/null)"; then
      printf '%s\n' "$out"
      return 0
    fi
    sleep "$poll"
  done
  return 1
}

# UNKNOWN only means GitHub has not finished computing, so it is neither a conflict nor a green light.
wait_mergeable() {
  local i state=''
  for ((i = 0; i < attempts; i++)); do
    state="$(gh_read pr view "$pr" --json mergeable,mergeStateStatus --jq '.mergeable + " " + .mergeStateStatus' || true)"
    case "$state" in
      CONFLICTING* | *DIRTY)
        echo "CONFLICT #$pr $state"
        exit 3
        ;;
      MERGEABLE\ UNKNOWN | UNKNOWN* | '') sleep "$poll" ;;
      *) return 0 ;;
    esac
  done
  echo "UNKNOWN_STATE #$pr $state"
  exit 7
}

# gh exits non-zero while checks are pending or failed, so the state comes from the output. Workflows
# register at different moments, so green must hold for two reads in a row.
wait_checks() {
  local i buckets green=0
  for ((i = 0; i < attempts; i++)); do
    buckets="$(gh pr checks "$pr" --json bucket --jq '[.[].bucket] | unique | join(" ")' 2>/dev/null || true)"
    case " $buckets " in
      *' fail '* | *' cancel '*)
        echo "CHECKS_FAILED #$pr"
        exit 4
        ;;
      *' pending '* | '  ') green=0 ;;
      *)
        green=$((green + 1))
        [ "$green" -lt 2 ] || return 0
        ;;
    esac
    sleep "$poll"
  done
  echo "CHECKS_PENDING #$pr"
  exit 7
}

# Both must agree: GitHub can show stale state, and only the repository settles it.
merged_sha() {
  local head="$1" sha
  sha="$(gh_read pr view "$pr" --json state,mergeCommit --jq 'select(.state == "MERGED") | .mergeCommit.oid' || true)"
  [ -n "$sha" ] || return 1
  git fetch --quiet origin main 2>/dev/null || return 1
  git merge-base --is-ancestor "$head" refs/remotes/origin/main 2>/dev/null || return 1
  printf '%s\n' "$sha"
}

latest_ci() {
  gh_read run list --workflow ci.yml --branch main --limit 30 --json headSha,conclusion \
    --jq "map(select(.headSha == \"$1\")) | .[0] // empty | if .conclusion == \"\" then \"pending\" else .conclusion end" || true
}

already_merged=0
[ "$(gh_read pr view "$pr" --json state --jq .state || true)" != "MERGED" ] || already_merged=1

if [ "$already_merged" -eq 0 ]; then
  wait_mergeable
  wait_checks
  wait_mergeable
  if [ "$merge" -eq 0 ]; then
    echo "READY #$pr"
    exit 0
  fi
fi

head="$(gh_read pr view "$pr" --json headRefOid --jq .headRefOid || true)"
[ -n "$head" ] || {
  echo "UNKNOWN_STATE #$pr head"
  exit 7
}

tries="$attempts"
if [ "$already_merged" -eq 0 ]; then
  if [ "$(gh_read pr view "$pr" --json isDraft --jq .isDraft || true)" != "false" ]; then
    gh_read pr ready "$pr" >/dev/null || true
    wait_mergeable
  fi
  # A 502 here can hide a merge that happened, so the answer comes from merged_sha below, not this exit.
  gh pr merge "$pr" --merge --match-head-commit "$head" >/dev/null 2>&1 || tries=$((attempts < 4 ? attempts : 4))
fi

sha=''
for ((i = 0; i < tries; i++)); do
  sha="$(merged_sha "$head" || true)"
  [ -n "$sha" ] && break
  sleep "$poll"
done
[ -n "$sha" ] || {
  echo "MERGE_UNCONFIRMED #$pr $head"
  exit 7
}
echo "MERGED #$pr $sha"
[ "$wait_deploy" -eq 1 ] || exit 0

# Deploy Workers starts after CI on main, and paths-ignore starts no CI on a docs-only merge. Without
# a CI run after a few polls, nothing is coming, so do not spend the whole wait on it.
run=''
quiet=0
for ((i = 0; i < attempts; i++)); do
  run="$(gh_read run list --workflow deploy-workers.yml --branch main --limit 20 --json databaseId,headSha \
    --jq "map(select(.headSha == \"$sha\")) | .[0].databaseId // empty" || true)"
  [ -n "$run" ] && break
  if [ -z "$(latest_ci "$sha")" ]; then
    quiet=$((quiet + 1))
    [ "$quiet" -lt 8 ] || break
  fi
  sleep "$poll"
done
[ -n "$run" ] || {
  echo "NO_DEPLOY #$pr $sha"
  exit 6
}

conclusion=''
for ((i = 0; i < attempts; i++)); do
  conclusion="$(gh_read run view "$run" --json status,conclusion \
    --jq 'select(.status == "completed") | .conclusion' || true)"
  [ -n "$conclusion" ] && break
  sleep "$poll"
done
case "$conclusion" in
  success) echo "DEPLOYED #$pr $run" ;;
  '')
    echo "DEPLOY_UNKNOWN #$pr $run"
    exit 7
    ;;
  cancelled)
    echo "DEPLOY_SUPERSEDED #$pr $run $sha"
    ;;
  skipped)
    # A merge in a row cancels the CI of the one before it, and that skips its deploy.
    if [ "$(latest_ci "$sha")" = "cancelled" ]; then
      echo "DEPLOY_SUPERSEDED #$pr $run $sha"
    else
      echo "DEPLOY_FAILED #$pr $run $conclusion"
      exit 5
    fi
    ;;
  *)
    echo "DEPLOY_FAILED #$pr $run $conclusion"
    exit 5
    ;;
esac
