# Go container routing (no-traffic Worker)

How the Worker sends a route to the Go backend in Cloudflare Containers (ADR 0032 §4, §6). Nothing here
changes production: the production Worker (`wrangler.jsonc`, deployed by `deploy-workers.yml`) declares no
container, no `GO_BACKEND` binding and no `SIPGES_GO_ROUTING`, so every request stays on TypeScript.
Every step below needs the owner's Cloudflare account and explicit go-ahead.

## How a request is routed

| Step | Where | What happens |
| --- | --- | --- |
| 1 | `src/index.ts` | SPA files and the HTML shell are served as before. |
| 2 | `src/go-routes.ts` | Only when `SIPGES_GO_ROUTING` is exactly `1`, `GO_BACKEND` is bound and `method path` is on `GO_ROUTES` (empty today). |
| 3 | `src/go-proxy.ts` | Same request context, security headers (CSP, `no-store`, HSTS) and host allowlist as the TypeScript API; no Hyperdrive connection opens. |
| 4 | `GoBackend` | One named instance (`go-enam`, location hint `enam`) of `apps/api-go/Dockerfile`, constrained to `regions = ["ENAM"]`. |
| 5 | Failure | A container that cannot start or answer gives the Worker's `503 {"detail": "SIPGES no está disponible temporalmente"}`. |

Everything else goes to the TypeScript backend unchanged. Switching a route back is removing its entry, or
unsetting `SIPGES_GO_ROUTING` for all of them.

## Adding a route

1. Port it to `apps/api-go` and add its cases to `apps/parity/src/cases.ts`; `pnpm parity` must pass.
2. Add `{ method, path }` to `GO_ROUTES` (`:name` matches one path segment). The Worker test refuses a route
   outside `/api/` and `/system/` or without a parity case for the same method and path.
3. Measure it through the `sipges-go` Worker (target from the container to Neon: warm p50 ≤ 35 ms,
   p95 ≤ 45 ms) and show the owner before any production change (S7).

Until identity moves to Go (phase 4), a Go route does not check sessions: unauthenticated requests to it would
not get TypeScript's 401. Only routes whose parity cases include the unauthenticated request may move.

## Choices

| Setting | Value | Why |
| --- | --- | --- |
| `constraints.regions` | `["ENAM"]` | Next to Neon `aws-us-east-1`; the spike landed in Toronto, Miami or Atlanta (26–33 ms warm p50). |
| `sleepAfter` | `10m` | Cold start after sleep is 0.74–0.88 s and every new database connection 170–230 ms. Only Go-routed requests keep it awake: 10 minutes covers the pauses between screens of a work session and bounds billed idle time after the last one. Once `/system/events` (polled every 10 s by an open screen) moves to Go, any open screen keeps it warm. |
| Warm pool | `pool_min_conns` default 2 | `apps/api-go` opens two connections in the background at start and pgx's health check replaces dropped ones, so a request does not pay for a new connection. The URL's `pool_min_conns` overrides it; it never exceeds `pool_max_conns`. |
| `instance_type` / `max_instances` | `lite` / `2` | One named instance serves; the second covers a rollout. |
| Database | `SIPGES_GO_DATABASE_URL` secret | Hyperdrive is not documented for containers (ADR 0032 L3): the container connects to Neon over TLS. |

## Trying it (`sipges-go` Worker)

`wrangler.go.jsonc` is a separate Worker, `sipges-go`, with no cron trigger and its own allowed host. No
workflow deploys it. Before the first deploy:

1. Create a Neon branch for trials and a Hyperdrive for it (`wrangler hyperdrive create …`); put its id in
   `wrangler.go.jsonc` (the placeholder is all zeros, and a test refuses the production id).
2. Create the R2 bucket `sipges-evidence-go`.
3. Build the SPA (`pnpm --filter @sipges/hosting-cloudflare build`) and migrate the branch.
4. Set the secrets with `wrangler secret put … -c wrangler.go.jsonc`: `SIPGES_DATA_KEY`, the admin
   variables of the deployment guide, and `SIPGES_GO_DATABASE_URL` (the branch's direct or pooled URL,
   `sslmode=verify-full`).
5. `wrangler deploy -c wrangler.go.jsonc` (needs Docker with buildx; it builds `apps/api-go/Dockerfile` from the repository root, sending only `apps/api-go` and `engines/go` per `Dockerfile.dockerignore`).

CI builds the same image and smoke-tests `/health` in the `Go image` job of `.github/workflows/go.yml`.
