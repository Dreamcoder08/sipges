#!/usr/bin/env bash
# Creates the worktree of one unit of work at .worktrees/<name>, from a fresh origin/main, on a new
# branch or an existing one. Every worktree needs its own index and dependencies, so nothing is copied.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/agents/new-worktree.sh <name> <branch> [--install]
  --install  also run pnpm install --frozen-lockfile (heavy; skip it for docs and Go-only work)
EOF
}

name=''
branch=''
install=0
while [ $# -gt 0 ]; do
  case "$1" in
    --install) install=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      usage >&2
      exit 2
      ;;
    *)
      if [ -z "$name" ]; then name="$1"; elif [ -z "$branch" ]; then branch="$1"; else
        usage >&2
        exit 2
      fi
      ;;
  esac
  shift
done
if [ -z "$branch" ] || [[ ! "$name" =~ ^[A-Za-z0-9._-]+$ ]]; then
  usage >&2
  exit 2
fi

common="$(git rev-parse --path-format=absolute --git-common-dir)"
target="$(dirname "$common")/.worktrees/$name"
[ ! -e "$target" ] || {
  echo "already exists: $target" >&2
  exit 1
}

git fetch origin --quiet
if git show-ref --verify --quiet "refs/heads/$branch"; then
  git worktree add --quiet "$target" "$branch"
else
  git worktree add --quiet -b "$branch" "$target" origin/main
fi
if [ "$install" -eq 1 ]; then
  (cd "$target" && pnpm install --frozen-lockfile)
fi
echo "$target"
