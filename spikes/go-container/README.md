# Go container spike (ADR 0032, gate S0)

A throwaway service that answers one question: can a Go backend in Cloudflare Containers,
constrained to `ENAM`, talk to Neon `aws-us-east-1` fast enough? It is not production code
and is not part of the pnpm workspace.

| Path | What it is |
| --- | --- |
| `cmd/spike` | Composition root: env config, HTTP server, graceful shutdown on SIGTERM. |
| `internal/latency` | Nearest-rank p50/p95/max of measured durations. |
| `internal/dbping` | Use case: open one connection, one first query, N warm `SELECT 1`. Ports: `Connector`, `Session`. |
| `internal/postgres` | pgx v5 adapter; times TCP, TLS and full connect. Errors never echo the DSN. |
| `internal/httpapi` | `GET /health`, `GET /db-ping?n=50&target=direct\|pooled`, `GET /egress`. |
| `Dockerfile` | Static binary on `distroless/static-debian12:nonroot`, both pinned by digest. |
| `worker/` | Spike Worker `sipges-go-spike` (not the production Worker) with the container binding. |
| `deploy.sh` / `measure.sh` | Build, push and deploy; measure from this machine through the Worker. |

## Endpoints

- `/health` — uptime since process start and the placement Cloudflare injects
  (`CLOUDFLARE_LOCATION`, `CLOUDFLARE_REGION`, `CLOUDFLARE_COUNTRY_A2`).
- `/db-ping` — requires `Authorization: Bearer $SPIKE_TOKEN` at the Worker. Reports
  `tcpConnectMs` (DNS + TCP), `tlsHandshakeMs` (SSLRequest + TLS handshake; pgx starts TLS lazily,
  so the adapter forces the handshake to time it), `connectTotalMs` (startup and SCRAM included),
  `firstQueryMs` and `warmQueries` (`count`, `minMs`, `p50Ms`, `p95Ms`, `maxMs`).
- `/egress` — the Cloudflare colo where the container's outbound traffic leaves (from
  `cdn-cgi/trace`, IP omitted).
- Worker `/worker` — edge-only baseline with `request.cf.colo`, no container.
  Container responses carry `x-worker-colo` and `x-container-fetch-ms`.

## Run

```sh
go test -race ./...                                   # unit tests
SPIKE_TEST_DATABASE_URL='postgres://sipges_test@127.0.0.1:55439/sipges_test?sslmode=disable' go test ./internal/postgres/
cd worker && pnpm install --ignore-workspace && pnpm typecheck && pnpm test   # typecheck generates the Worker types first

./deploy.sh                                            # needs a logged-in wrangler and docker
printf %s "$URL" | (cd worker && npx wrangler secret put DATABASE_URL -c .wrangler.generated.json)
# same for DATABASE_URL_POOLED (optional) and SPIKE_TOKEN
SPIKE_URL=https://sipges-go-spike.<subdomain>.workers.dev SPIKE_TOKEN=... ./measure.sh warm 50
SPIKE_URL=... ./measure.sh cold 4

(cd worker && npx wrangler delete --name sipges-go-spike)   # tear down when done
```

`deploy.sh` builds and pushes the image itself because `wrangler deploy` needs `docker buildx`
to build a Dockerfile. With buildx installed, `cd worker && npx wrangler deploy` works directly.

## Why not UPX

Measured on the built image (30 runs each, exec to first `200` on `/health`):

| Binary | Size | Image (gzip) | Startup p50 / p95 | RSS |
| --- | --- | --- | --- | --- |
| stripped (`-s -w`) | 11.0 MB | 4.51 MB | 68 / 137 ms | 8.8 MB |
| `upx --best --lzma` | 2.9 MB | 3.51 MB | 291 / 455 ms | 10.9 MB |

Registry layers are already gzip-compressed, so UPX saves 1 MB on the wire while it adds
about 220 ms of decompression to every start and 2 MB of memory. Cold start is one of the gate
criteria, so the default image is not packed; the `runtime-upx` target exists only to reproduce
the measurement.

## Results (2026-11-03, measured from Lima through the Worker)

Neon `aws-us-east-1`, throwaway copy-on-write branch, 0.25 CU, database `neondb`, only `SELECT 1`.
Worker edge was always `LIM`. Warm figures: 100 queries per run, at least 3 runs per row.

| Gate (ADR 0032 §4) | Result |
| --- | --- |
| (a) TLS TCP to Neon | **Pass.** Direct and pooled hosts, port 5432, `sslmode=verify-full`. |
| (b) warm p50 ≤ 10 ms, p95 ≤ 25 ms | **Fail.** See placement table: best p50 18.8 ms (Toronto, pooled), typical 26–33 ms. |
| (c) cold start ≤ 3 s | **Pass after sleep** (4/4: 0.74–0.88 s end to end, 0.64–0.75 s in the container fetch). The first start after a deploy took 3.22 s. |

| Container placement (`CLOUDFLARE_LOCATION`) | Constraint | TCP connect | Warm p50 / p95 direct | Warm p50 / p95 pooled |
| --- | --- | --- | --- | --- |
| `yyz04` Toronto, CA | `regions: [ENAM]` | 21–36 ms | 29.8–32.1 / 31.9–32.4 ms | 18.8–22.7 / 19.2–23.2 ms |
| `mia09` Miami, US | `+ jurisdiction: us` | 32–35 ms | 30.6–32.1 / 31.2–32.4 ms | 29.6–33.7 / 30.6–34.1 ms |
| `atl13` Atlanta, US | `+ DO locationHint: enam` | 28–30 ms | 25.7–26.5 / 26.1–27.0 ms | 25.9–27.7 / 26.1–38.8 ms |
| Lima, no container (baseline) | — | 120–124 ms | 121.1 / 130.1 ms | 115.6 / 166.7 ms |

- `ENAM` does not mean Virginia. Placement moved between Toronto, Miami and Atlanta, and changed on
  every restart of the same instance (Miami and Atlanta alternated across the 4 cold starts). The
  wrangler schema (4.151.2) offers only `regions` and `jurisdiction`, with no city or data-centre option.
- Outbound traffic leaves Cloudflare at the container's own colo (`/egress` returned `ATL`, `MIA`), so the
  extra time is internet distance to AWS us-east-1, not Go or pgx overhead. Hyperdrive would not lower it:
  its pool sits near the database, but every query would still cross that same distance.
- Warm `/health` from Lima: p50 238 ms (Worker only: 77 ms). The Worker → container hop added about
  160 ms because the container ran in ATL, not near the LIM edge.
- Connect cost per new connection: about 170–230 ms (TCP + TLS + SCRAM), so the Go service needs a warm pool.
- Teardown: `wrangler delete` removed the Worker but left the container application `active`.
  `wrangler containers delete <id>` and `wrangler containers images delete` are needed as well.
