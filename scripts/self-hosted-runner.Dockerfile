# Image for scripts/self-hosted-runner.sh: the official runner plus the Node that GitHub-hosted images preinstall
# (pnpm/action-setup runs before actions/setup-node and needs a node binary).
FROM node:22.20.0-bookworm-slim AS node
FROM ghcr.io/actions/actions-runner:2.338.0
COPY --from=node /usr/local/bin/node /usr/local/bin/node

# Playwright's system libraries for Chromium and WebKit, baked in so the e2e job installs browsers without apt.
# Must match @playwright/test in apps/e2e (lockfile); scripts/self-hosted-runner.sh passes that version.
# npm is only needed for this step (the plain docker builder has no BuildKit --mount).
ARG PLAYWRIGHT_VERSION=1.63.0
COPY --from=node /usr/local/lib/node_modules/npm /tmp/npm
USER root
RUN npm_config_cache=/tmp/npm-cache node /tmp/npm/bin/npx-cli.js -y "playwright@${PLAYWRIGHT_VERSION}" \
      install-deps chromium webkit \
    && rm -rf /tmp/npm /tmp/npm-cache /var/lib/apt/lists/*
USER runner
