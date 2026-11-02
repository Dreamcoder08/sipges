# Image for scripts/self-hosted-runner.sh: the official runner plus the Node that GitHub-hosted images preinstall
# (pnpm/action-setup runs before actions/setup-node and needs a node binary).
FROM node:22.20.0-bookworm-slim AS node
FROM ghcr.io/actions/actions-runner:2.338.0
COPY --from=node /usr/local/bin/node /usr/local/bin/node
