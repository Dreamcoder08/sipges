#!/usr/bin/env bash
# Formats only the files this branch changed against origin/main (SIPGES_VERIFY_BASE to override).
set -euo pipefail

base="${SIPGES_VERIFY_BASE:-origin/main}"
merge_base="$(git merge-base "$base" HEAD)"
files=()
while IFS= read -r -d '' file; do
  [ ! -e "$file" ] || files+=("$file")
done < <(git diff -z --name-only --diff-filter=d "$merge_base")
# set -e does not see a process substitution, so its status is collected here.
wait "$!"
[ "${#files[@]}" -eq 0 ] || prettier --write --ignore-unknown "${files[@]}"
