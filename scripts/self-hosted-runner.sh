#!/usr/bin/env bash
# Runs the repository's self-hosted GitHub Actions runner in a container on this machine.
# Usage: scripts/self-hosted-runner.sh start|stop|status
# Docs: docs/operations/ci-runner.md
set -euo pipefail

REPO="${SIPGES_RUNNER_REPO:-Dreamcoder08/sipges}"
NAME="sipges-runner"
IMAGE="sipges-runner:local"
DOCKERFILE="$(dirname "$0")/self-hosted-runner.Dockerfile"
LABELS="sipges-local"
VOLUME="sipges-runner-work"

start() {
  if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
    echo "$NAME is already running"
    return
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker build -q -t "$IMAGE" -f "$DOCKERFILE" "$(dirname "$DOCKERFILE")" >/dev/null
  token="$(gh api -X POST "repos/$REPO/actions/runners/registration-token" --jq .token)"
  docker_gid="$(stat -c %g /var/run/docker.sock)"
  # --network host: job steps reach service containers on 127.0.0.1:<mapped port>, as on GitHub-hosted runners.
  # The Docker socket lets jobs start their service containers on the host daemon.
  docker run -d --name "$NAME" --restart unless-stopped \
    --network host \
    --group-add "$docker_gid" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$VOLUME":/home/runner/_work \
    -e RUNNER_TOKEN="$token" \
    --entrypoint bash "$IMAGE" -c "
      # A new named volume is owned by root; the runner user must own its work directory.
      sudo chown runner:runner /home/runner/_work &&
      # Register only on first start: the token expires after an hour, and a restart keeps the registration.
      [ -f .runner ] || ./config.sh --unattended --replace --url https://github.com/$REPO --token \"\$RUNNER_TOKEN\" \
        --name $NAME --labels $LABELS --work /home/runner/_work &&
      exec ./run.sh" >/dev/null
  echo "$NAME started; set the repository variable SIPGES_RUNS_ON to [\"self-hosted\",\"$LABELS\"] to use it"
}

stop() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  id="$(gh api "repos/$REPO/actions/runners" --jq ".runners[] | select(.name == \"$NAME\") | .id")"
  if [ -n "$id" ]; then gh api -X DELETE "repos/$REPO/actions/runners/$id"; fi
  echo "$NAME stopped and unregistered"
}

status() {
  docker ps --filter "name=^$NAME$" --format '{{.Names}} {{.Status}}'
  gh api "repos/$REPO/actions/runners" --jq '.runners[] | "\(.name) \(.status) busy=\(.busy)"'
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
