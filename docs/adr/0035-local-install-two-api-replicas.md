# 0035 — Local install: an optional second API behind Caddy, taken in turns with health checks

## Status

Accepted (2026-11-17).

## Context

The owner asked, in this order: «agrega un balanceador de carga», «roun robin por turnos», «use health
cheks». The owner's priority is the local install (`deploy/local`), which runs on one machine. There
the goal is availability, not capacity: a failed API is skipped, a request retries on the other one,
and `./sipges update` restarts the application without a gap.

Facts read on 2026-11-17:

- **The Go API holds no state that two copies would split.** Sessions, sign-in throttling, MFA,
  idempotency keys and the analyst live in PostgreSQL. The automation cron claims work with
  `FOR UPDATE … SKIP LOCKED` and conditional updates, so two crons never send twice. Uploads are
  written by atomic rename on the shared `uploads` volume. `/system/events` polls the audit table.
  Two copies do overwrite each other's cron tick token
  (`apps/api-go/internal/automation/infrastructure/runtime.go`), which only shows a wrong status and
  scans twice. A role grant is cached 30 s in each copy.
- **Before this decision nothing balanced or checked.** `deploy/local/Caddyfile` had
  `reverse_proxy api:8080` with no policy, health check or retry; the `api` service had no
  healthcheck; `./sipges update` recreated `api` in one step, so the site was down until the new
  version answered.
- **The API image is distroless** (`apps/api-go/Dockerfile`): no shell, `curl` or `wget` for a
  Compose healthcheck.
- **Caddy cannot actively check dynamic upstreams.** The pinned Caddy is v2.11.9. Its
  `reverse_proxy` documentation says of `dynamic a`: «Active health checks do not run for dynamic
  upstreams» ([reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)).
  Environment variables in the `{$NAME}` form are replaced before the Caddyfile is parsed, so one
  variable can hold several upstreams
  ([Caddyfile concepts](https://caddyserver.com/docs/caddyfile/concepts#environment-variables)).

## Decision

1. **Opt-in.** `SIPGES_API_REPLICAS=2` in `.env` runs a second API, `api-2`. Unset or `1` keeps one
   API and the exact `docker compose` calls of before. Any other value stops `./sipges` before a
   backup, build or container.
2. **Same API, twice.** `api-2` takes every setting of `api` from one Compose extension (`x-api`):
   image, environment, `uploads` volume, networks, limits and healthcheck. It sits in the Compose
   profile `replica`, which `./sipges` enables when the setting is `2`. The service `api` keeps its
   name.
3. **The cron runs on `api` alone.** `api-2` sets `SIPGES_GO_AUTOMATION_CRON=0`. Scheduled automation
   pauses while `api` restarts, and the tick token is no longer overwritten.
4. **Caddy takes the APIs in turns and checks them.** `reverse_proxy` lists static upstreams from
   `SIPGES_API_UPSTREAMS` (`api:8080`, or `api:8080 api-2:8080` set by `./sipges`), with
   `lb_policy round_robin`, active checks of `/health/ready` every 5 s (2 s timeout, any 2xx, with the
   site's `Host`, since the API refuses other names), passive `fail_duration 5s`, and
   `lb_try_duration 5s` with `lb_retries 2`, so a request that cannot reach one API tries the other.
5. **Docker checks each API too.** The healthcheck runs `/api healthcheck`, a subcommand of the API
   binary that asks `127.0.0.1:$SIPGES_PORT/health/ready` as the first allowed host and exits 0 or 1.
6. **Two APIs restart one at a time.** With `2`, `./sipges start` and `update` run `migrate`, then
   restart `api` and wait until Docker calls it healthy, wait 10 s more so Caddy counts it back in
   (one check interval plus `fail_duration`), then restart `api-2` the same way, then Caddy and the
   backups. A longer `fail_duration` (30 s was tried) left both APIs counted down during the second
   restart: the smoke run answered 42 of 300 requests with 502 or 503. If `api` never becomes healthy, `api-2` keeps the version it had. A restore stops
   both.
7. **Migrations stay compatible with the previous version.** They run while the old version still
   serves, so a migration may add but not remove or rename what the running version reads, until a
   later release. This holds for every release once any install runs two APIs.

## Consequences

- Easier: an update or a crashed API no longer takes the site down when two run; Caddy stops
  sending to an API that fails `/health/ready` within 5 s.
- Harder: a release that drops a column or table must first ship a version that stops using it.
  An operator's override file must give `api-2` the same changes as `api`. Each API uses up to 1 GiB.
- Unchanged: one API by default. On one machine two APIs give no extra capacity; they share its CPU,
  memory and database.
- Must now happen: `deploy/local/test/unit.sh` pins the one-API calls and the rolling order;
  `docs/deployment/local-install.md` explains the setting and the migration rule.

## Alternatives considered

- **More replicas on one host for capacity.** Rejected: they share one CPU and one database; the
  owner's goal on one host is availability.
- **`docker compose up --scale api=2`.** Rejected: one `up` replaces the copies of a scaled service
  without waiting for one to be healthy before the next, and the copies cannot differ (the cron).
- **The cron on both APIs.** Rejected: correct thanks to the database claims, but it scans twice and
  each copy overwrites the other's tick token.
- **Caddy `dynamic a` upstreams on one DNS name.** Rejected: active health checks do not run for
  dynamic upstreams, and the owner asked for health checks.
