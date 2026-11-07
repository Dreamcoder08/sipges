# syntax=docker/dockerfile:1
# The image of a local install: the Go API image, unchanged, plus what the Cloudflare Worker and
# the deploy workflow provide in the cloud, the built web app and the SQL migrations. `./sipges
# build` builds apps/api-go/Dockerfile first, as sipges-api-go:local. Context: the repository root.
FROM --platform=linux/amd64 node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS web
RUN npm install --global pnpm@12.11.2 && mkdir -p /volume/uploads
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --filter '@sipges/web...' && pnpm --filter @sipges/web build

FROM sipges-api-go:local
COPY --from=web /src/apps/web/dist /web
COPY --from=web /src/apps/api/src/platform/database/migrations /migrations
# A named volume starts with this folder's owner, so the API's user can write its evidence files.
COPY --from=web --chown=65532:65532 /volume/uploads /data/uploads
ENV SIPGES_WEB_DIR=/web SIPGES_MIGRATIONS_DIR=/migrations SIPGES_STORAGE=local SIPGES_UPLOAD_DIR=/data/uploads
