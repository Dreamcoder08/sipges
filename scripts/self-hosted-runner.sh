#!/usr/bin/env bash
# Runs the repository's self-hosted GitHub Actions runner in a container on this machine.
# Usage: scripts/self-hosted-runner.sh start [count]|stop|status   (count defaults to 1; each runner takes one job at a time)
# Docs: docs/operations/ci-runner.md
set -euo pipefail

REPO="${SIPGES_RUNNER_REPO:-Dreamcoder08/sipges}"
PREFIX="sipges-runner"
IMAGE="sipges-runner:local"
DOCKERFILE="$(dirname "$0")/self-hosted-runner.Dockerfile"
LABELS="sipges-local"
# Caches live inside each runner's own work volume: no two runners write the same cache, and pnpm can hard-link
# from its store into node_modules because both sit on the same mount.
CACHE_DIR="/home/runner/_work/_cache"
# The image bakes Playwright's system libraries for the version apps/e2e pins (lockfile).
PLAYWRIGHT_VERSION="$(sed -n 's/.*"@playwright\/test": "\([0-9.]*\)".*/\1/p' "$(dirname "$0")/../apps/e2e/package.json")"

start() {
  local count="${1:-1}" built=""
  for i in $(seq 1 "$count"); do
    local name="$PREFIX"
    [ "$i" -gt 1 ] && name="$PREFIX-$i"
    if docker ps --format '{{.Names}}' | grep -qx "$name"; then
      echo "$name is already running"
      continue
    fi
    docker rm -f "$name" >/dev/null 2>&1 || true
    if [ -z "$built" ]; then
      docker build -q -t "$IMAGE" --build-arg PLAYWRIGHT_VERSION="$PLAYWRIGHT_VERSION" \
        -f "$DOCKERFILE" "$(dirname "$DOCKERFILE")" >/dev/null
      built=1
    fi
    local token docker_gid
    token="$(gh api -X POST "repos/$REPO/actions/runners/registration-token" --jq .token)"
    docker_gid="$(stat -c %g /var/run/docker.sock)"
    # --network host: job steps reach service containers on 127.0.0.1:<mapped port>, as on GitHub-hosted runners.
    # The Docker socket lets jobs start their service containers on the host daemon.
    docker run -d --name "$name" --restart unless-stopped \
      --network host \
      --group-add "$docker_gid" \
      -v /var/run/docker.sock:/var/run/docker.sock \
      -v "$name-work":/home/runner/_work \
      -e RUNNER_TOKEN="$token" \
      -e PLAYWRIGHT_BROWSERS_PATH="$CACHE_DIR/ms-playwright" \
      -e pnpm_config_store_dir="$CACHE_DIR/pnpm-store" \
      --entrypoint bash "$IMAGE" -c "
        # A new named volume is owned by root; the runner user must own its work directory.
        sudo chown runner:runner /home/runner/_work &&
        # Register only on first start: the token expires after an hour, and a restart keeps the registration.
        [ -f .runner ] || ./config.sh --unattended --replace --url https://github.com/$REPO --token \"\$RUNNER_TOKEN\" \
          --name $name --labels $LABELS --work /home/runner/_work &&
        exec ./run.sh" >/dev/null
    echo "$name started"
  done
  echo "Set the repository variable SIPGES_RUNS_ON to [\"self-hosted\",\"$LABELS\"] to use the runners"
}

stop() {
  local names
  names="$(docker ps -a --format '{{.Names}}' | grep -E "^$PREFIX(-[0-9]+)?$" || true)"
  for name in $names; do
    docker rm -f "$name" >/dev/null 2>&1 || true
    id="$(gh api "repos/$REPO/actions/runners" --jq ".runners[] | select(.name == \"$name\") | .id")"
    if [ -n "$id" ]; then gh api -X DELETE "repos/$REPO/actions/runners/$id"; fi
    echo "$name stopped and unregistered"
  done
}

status() {
  docker ps --filter "name=^$PREFIX" --format '{{.Names}} {{.Status}}'
  gh api "repos/$REPO/actions/runners" --jq '.runners[] | "\(.name) \(.status) busy=\(.busy)"'
}

case "${1:-}" in
  start) start "${2:-1}" ;;
  stop) stop ;;
  status) status ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
