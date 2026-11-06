# Moving the Inicio and Registros reads to Go: go/no-go

**Verdict at `3e6f60ff`: NO-GO for production.** The Go code is ready for these reads; the platform around it is not. Every read matched TypeScript on synthetic data, in parity and in a real browser. Nothing has been measured on Cloudflare and production cannot reach a container yet. This document prepares T44; it changes no route (`GO_ROUTES` stays empty, S7).

## Blockers

Each one stops the switch on its own. The numbers are names, not a sequence: [Order of work](#order-of-work) says when each is cleared.

| # | Blocker | Evidence | What clears it |
| --- | --- | --- | --- |
| B1 | No trial of this image has run on Cloudflare. | The [trial runbook](go-trial-runbook.md) is ready and has not run; L7 left the trial pending, and the last Cloudflare numbers are the T2 spike, a minimal container without the engines. | Follow the [trial runbook](go-trial-runbook.md) with the owner. |
| B2 | No before/after measurement exists (S7). | Nothing in the repository measures a Go route through a Worker. | [Measurement](#measurement-with-the-owner) passes. |
| B3 | `basic` may be too small. One named instance takes all traffic, with 1/4 vCPU. | Local table in [go-container.md](go-container.md#memory): 2.2–2.5 req/s, p95 3.5–5.3 s at 4–8 clients (it does not say which routes). Production today: 682 requests in 20 s at 8 screens, about 34 req/s (`backend-latency` L19). A local figure is not a Cloudflare figure, but the gap is more than tenfold. | Measure B2 at 8 screens. If it fails, Fly.io `iad` is the fallback in ADR 0032 §4. |
| B4 | Production has no route to a container. | `wrangler.jsonc` has no `containers`, `durable_objects` or `SIPGES_GO_ROUTING`, and `go-routing.test.ts` asserts so. `deploy-workers.yml` has no buildx. | One reviewed PR: the config, the Durable Object migration, buildx, and that test changed on purpose. |
| B5 | Cleared: a container failure is the Worker's JSON 503. | `@cloudflare/containers` 0.3.7 **returns** text responses instead of throwing (`dist/lib/container.js`): 503, 429, and 500 with the internal message. `go-proxy.ts` now maps those and any thrown error; `go-proxy.test.ts` holds each text. **Unverified** on Cloudflare until the trial. | Done. |
| B6 | Cleared: the deploy smoke test can see a dead container. | `deploy-workers.yml` runs `smoke-go.mjs` after `/health/ready`, and a failure rolls the Worker back. It asks a listed route with no session for the JSON 401; the Worker's 503 fails it. It sends nothing while `GO_ROUTES` is empty. A TypeScript 401 also passes, so it proves Go only with `SIPGES_GO_ROUTING=1`. **Unverified** on Cloudflare until the trial. | Done. |
| B7 | Parity has never seen production-shaped rows. | All evidence is synthetic. L24 and L25 record known differences that only legacy data could show, both harmless so far. | Owner decision: compare both APIs on a Neon branch of production, or accept the risk. Any such run is a real-data run and needs the owner's word. |

## What is already true

These no longer block the reads. Measured here on synthetic data unless marked.

| Question | Answer | How it was checked |
| --- | --- | --- |
| Does Go accept a session TypeScript issued? | Yes. Same cookie (`sipges_session`), same SHA-256 lookup, no key involved. | Real browser login through TypeScript, then 82 Go responses with that cookie, 0 errors. `Secure` was off locally; **a cookie issued on Workers is unverified** until the trial. |
| Does the MFA gate match with it on, as production? | Yes, with the default on and a session without TOTP. | 26 of 26 URLs identical (25 `403`, `me` `200`). Parity itself runs with MFA off, so it does not show this. |
| Are security headers and `no-store` applied? | Yes, by the Worker. Go sets neither, so Go must only be reached through `go-proxy.ts`. | `no-store`, `nosniff`, CSP and HSTS seen on a proxied answer. |
| Does the container env start Go and serve the reads? | Yes, locally. | 1866 of 1888 parity cases with Go on `goContainerEnv` plus `SIPGES_REQUIRE_MFA=0`, which the parity session needs and the container does not get; all 22 differences are `POST` uploads and TOTP, none in `screens.ts`. The MFA-on row above covers the default. |
| Do the reads need writes in Go first? | No. Reads move alone, and every write stays on TypeScript until its own wave. | `go-activation-reads.test.ts` keeps the read waves `GET` only. |

## Routes of the two screens

Found by reading `apps/web` and confirmed by watching the browser. `Parity` counts `GET` cases on that path at this commit, all equal; `/system/events` is compared by Go tests only.

Every authenticated screen, on first paint:

| Call | Go route | Parity | Decision |
| --- | --- | --- | --- |
| `GET /system/auth/current-scope` | yes (T14) | 8 | Wave C |
| `GET /system/auth/me` | yes (T15) | 6 | Wave C |
| `GET /system/auth/scopes` | yes (T33) | 10 | Wave C |
| `GET /system/notifications?limit=30`, every 60 s | yes (T31) | 29 | Wave A |
| `GET /system/v4/settings` | yes (T20) | 16 | Wave A |
| `GET /system/events` (SSE stream) | yes (T16) | none, by design | **Stays on TypeScript** |

Inicio (`/inicio`) and the executive dashboard (`/`):

| Call | Go route | Parity | Decision |
| --- | --- | --- | --- |
| `GET /api/dashboard` | yes (T24) | 8 | Wave A |
| `GET /api/alertas?limit=500&offset=0&q=` | yes (T25) | 7 | Wave A |
| `GET /api/eventos?limit=500&offset=0&q=` | yes (T25) | 9 | Wave A |
| `GET /system/irsa` | yes (T23) | 9 | Wave A |
| `GET /system/model-status` (`/` only) | yes (T23) | 8 | Wave A |

Registros (`/registros` and the lists of the sixteen modules):

| Call | Go route | Parity | Decision |
| --- | --- | --- | --- |
| `GET /api/registros/summary?limit=500&offset=N` | yes (T25) | 32 | Wave A |
| `GET /api/{module}?limit=500&offset=N&q=` | yes (T25) | 7+ per module | Wave A |
| `GET /system/uploads?linked_module=fuentes&limit=500` | yes (T28) | 40 | Wave A |
| `GET /api/{module}/{id}`, on opening a record | yes (T25) | 5+ per module | Wave B |
| `GET /api/{module}/{id}/history`, on opening a record | yes (T25) | 2+ per module | Wave B |
| `GET /system/links?module=…&id=…`, on opening a record | yes (T26) | 32 | Wave B |
| `GET /system/ontology`, on opening a record | yes (T26) | 10 | Wave B |
| `GET /system/uploads/{id}/preview` | yes (T57, [ADR 0033](../adr/0033-pdf-text-in-wasm.md)), but no S3 env | n/a | **Stays on TypeScript** |
| `GET /system/uploads/{id}/download` | yes, but no S3 env | n/a | **Stays on TypeScript** |

Modules: `eventos`, `actores`, `directorio`, `demandas`, `compromisos`, `narrativas`, `fuentes`, `alertas`, `acciones`, `intereses`, `dialogos`, `oportunidades`, `hechos`, `aarc`, `buzon`, `lecciones`.

Not in Waves A to C: every write the screens can make, the search palette, the Gerencial tab of Inicio, and `GET /system/auth/providers` (the login page). Wave D and the write waves below cover what else is ported.

### Why `/system/events` stays

It has no parity case, it streams for up to 240 s per connection, and through the container one open tab would hold it awake. Move it on its own.

### Gap closed by this task

Before T48, `validateGoRoutes` refused 33 of these routes for lack of a parity case, including `/api/alertas`, which Inicio calls. No case used the exact URL the browser sends. `apps/parity/src/contexts/screens.ts` adds 236 cases: for all sixteen modules the exact list URL with `X-SIPGES-Scope`, a `restringido` row hidden from `consulta`, the same id in a foreign project, and a list long enough to need its second page.

## Proposed `GO_ROUTES`

Copy these only into a reviewed change, one wave at a time. Waves A to D are `GET` only and name each module: `/api/:module` would also catch paths nobody compared. `go-activation-reads.test.ts` holds these blocks to what the Worker accepts.

Wave A, the data of each first paint. A failure here leaves the shell standing:

```text go-routes
GET /api/dashboard
GET /system/irsa
GET /system/model-status
GET /api/registros/summary
GET /system/notifications
GET /system/v4/settings
GET /system/uploads
GET /api/eventos
GET /api/actores
GET /api/directorio
GET /api/demandas
GET /api/compromisos
GET /api/narrativas
GET /api/fuentes
GET /api/alertas
GET /api/acciones
GET /api/intereses
GET /api/dialogos
GET /api/oportunidades
GET /api/hechos
GET /api/aarc
GET /api/buzon
GET /api/lecciones
```

Wave B, opening a record:

```text go-routes
GET /api/eventos/:id
GET /api/eventos/:id/history
GET /api/actores/:id
GET /api/actores/:id/history
GET /api/directorio/:id
GET /api/directorio/:id/history
GET /api/demandas/:id
GET /api/demandas/:id/history
GET /api/compromisos/:id
GET /api/compromisos/:id/history
GET /api/narrativas/:id
GET /api/narrativas/:id/history
GET /api/fuentes/:id
GET /api/fuentes/:id/history
GET /api/alertas/:id
GET /api/alertas/:id/history
GET /api/acciones/:id
GET /api/acciones/:id/history
GET /api/intereses/:id
GET /api/intereses/:id/history
GET /api/dialogos/:id
GET /api/dialogos/:id/history
GET /api/oportunidades/:id
GET /api/oportunidades/:id/history
GET /api/hechos/:id
GET /api/hechos/:id/history
GET /api/aarc/:id
GET /api/aarc/:id/history
GET /api/buzon/:id
GET /api/buzon/:id/history
GET /api/lecciones/:id
GET /api/lecciones/:id/history
GET /system/links
GET /system/ontology
```

Wave C, the session bootstrap. **Last on purpose:** the route guard needs these, so if the container fails the whole app fails, with no fallback to TypeScript.

```text go-routes
GET /system/auth/me
GET /system/auth/scopes
GET /system/auth/current-scope
```

URLs of a first paint that carry `X-SIPGES-Scope`, copied by hand from `apps/web`, each with a parity case. Nothing ties this block to the web code: re-read it when a URL builder changes. The three Wave C calls send no project header and have their own cases.

```text first-paint
/system/notifications?limit=30
/system/v4/settings
/api/dashboard
/system/irsa
/system/model-status
/api/registros/summary?limit=500&offset=0
/system/uploads?linked_module=fuentes&limit=500
/api/eventos?limit=500&offset=0&q=
/api/actores?limit=500&offset=0&q=
/api/directorio?limit=500&offset=0&q=
/api/demandas?limit=500&offset=0&q=
/api/compromisos?limit=500&offset=0&q=
/api/narrativas?limit=500&offset=0&q=
/api/fuentes?limit=500&offset=0&q=
/api/alertas?limit=500&offset=0&q=
/api/acciones?limit=500&offset=0&q=
/api/intereses?limit=500&offset=0&q=
/api/dialogos?limit=500&offset=0&q=
/api/oportunidades?limit=500&offset=0&q=
/api/hechos?limit=500&offset=0&q=
/api/aarc?limit=500&offset=0&q=
/api/buzon?limit=500&offset=0&q=
/api/lecciones?limit=500&offset=0&q=
```

Wave D, the other reads ported to Go. They need nothing beyond what the container gets today, and they are compared by parity, not yet watched in a browser. Take them screen by screen:

```text go-routes
GET /system/indicators
GET /system/irsa/config
GET /system/irsa/history
GET /system/prevention/actions
GET /system/prevention/situation-room
GET /system/prevention/summary
GET /system/management/overview
GET /system/management/report.csv
GET /system/audit
GET /system/timeline
GET /system/graph
GET /system/canonical-entities
GET /system/project-coordinates
GET /system/validation-template
GET /system/geography/catalogue
GET /system/conflict-risk
GET /system/v4/situations
GET /system/v4/media
GET /system/situational-analysis
GET /system/strategic-assessment
GET /system/consensus-engine
GET /system/integrated-analysis
GET /system/situational-report.docx
GET /system/strategic-report.docx
GET /system/integrated-analysis.docx
GET /system/consensus-engine.docx
GET /system/intelligence/sources
GET /system/intelligence/territorial-alerts
GET /system/intelligence/territorial-alerts/:id
GET /system/intelligence/territorial-summary
GET /system/document-lab/review
GET /system/briefing
GET /system/briefing/proposals
GET /system/export
GET /system/automations
GET /system/automations/runs
GET /system/automations/runtime
GET /system/auth/accounts
GET /system/integrations/api-keys
```

Reads that stay on TypeScript for now:

| Route | Why |
| --- | --- |
| `/system/events` | See [above](#why-systemevents-stays). |
| `/system/uploads/{id}`, `/preview`, `/download` | No S3 settings in the container; PDF and DOCX preview answer 501 (L37). |
| `/system/search`, `/system/intelligence/embedder` | Their answers depend on `SIPGES_OLLAMA_*` and `SIPGES_SEMANTIC_SEARCH`, which the container does not get. |
| `/system/intelligence/sources/defensoria/preview` | Calls an outside site; moves with Wave H. |
| `/system/notifications/push`, `/push/state` | Need `SIPGES_VAPID_*`. |
| `/system/auth/providers` | Needs `SIPGES_GOOGLE_*`; the login page depends on it. |
| `/system/metrics` | Counts one process: on Go it would stop showing the Worker's requests. |
| `/system/automations/cron` | See [go-automation-cron.md](go-automation-cron.md). |
| `/system/intelligence/` | No parity case. |

## Proposed writes, not before the reads

Every write is ported, but **none is proposed yet**, and 56 of them have no parity case of their own (see the gap below). These lists say what would move and what each wave needs. They are not a go-ahead. Writes change the rollback: a route can go back, but rows Go wrote stay, so a defect here is not undone by a deploy. Start only after Waves A to D are measured, and after the owner decides. `go-activation-reads.test.ts` holds these blocks to the Worker's check too.

| Wave | Needs first |
| --- | --- |
| E, records and project data | `SIPGES_DATA_KEY` and `SIPGES_DATA_KEY_PREVIOUS` forwarded: these writes wake automation in Go, and its channels need the key. Reread the verifier evidence of L36 and T37 against the build that moves. |
| F, identity, keys and automations | The same, plus an independent verifier, as identity is a high-risk area. |
| G, uploads and documents | `SIPGES_STORAGE`, `SIPGES_S3_*` and `SIPGES_MAX_UPLOAD_BYTES` forwarded; a timeout on the `http.Client` in `objectstore/s3.go` (L37), which has none today; the owner's choice on the `basic` PDF limit (ADR 0033). |
| H, outside services | `SIPGES_OLLAMA_*`, `SIPGES_ANALYST_*`, `ANTHROPIC_*` and `SIPGES_VAPID_*` forwarded, as each is used in production. |

Wave E:

```text go-writes
POST /api/eventos
POST /api/demandas
POST /api/buzon
PUT /api/compromisos/:id
PUT /api/buzon/:id
DELETE /api/compromisos/:id
DELETE /api/buzon/:id
POST /system/links
DELETE /system/links/:id
PUT /system/links/:id/evidence
PUT /system/marking
PUT /system/v4/settings
POST /system/irsa/config
POST /system/irsa/snapshot
POST /system/prevention/actions
PATCH /system/prevention/actions/:id
POST /system/intelligence/territorial-alerts
PATCH /system/intelligence/territorial-alerts/:id
POST /system/notifications/read
PATCH /system/document-lab/review/:id
POST /system/document-lab/review/bulk
POST /system/graph/neighbourhood
POST /system/geography/query
```

Wave F:

```text go-writes
POST /system/auth/accounts
POST /system/auth/accounts/:username/deactivate
POST /system/auth/accounts/:username/google
POST /system/auth/accounts/:username/reset-mfa
POST /system/auth/grants
DELETE /system/auth/grants
POST /system/auth/scopes
POST /system/auth/totp/setup
POST /system/auth/totp/enable
POST /system/integrations/api-keys
DELETE /system/integrations/api-keys/:id
POST /system/automations/rules
PUT /system/automations/rules/:id
DELETE /system/automations/rules/:id
POST /system/automations/channels
DELETE /system/automations/channels/:id
POST /system/automations/channels/:id/test
POST /system/automations/tick
```

Wave G:

```text go-writes
POST /system/import/compromisos
POST /system/uploads
POST /system/document-lab/analyze
POST /system/document-lab/compare
POST /system/document-lab/report.docx
POST /system/document-lab/review/import
POST /system/analyze
```

Wave H:

```text go-writes
POST /system/intelligence/analyze-text
POST /system/intelligence/semantic-analyze
POST /system/intelligence/sources/defensoria/import
POST /system/intelligence/sources/defensoria/poll
PUT /system/intelligence/sources/defensoria/config
POST /system/briefing/proposals
POST /system/notifications/push
POST /system/notifications/push/test
POST /system/notifications/push/unsubscribe
POST /system/v4/media/feeds
PUT /system/v4/media/feeds/:id
DELETE /system/v4/media/feeds/:id
POST /system/v4/media/poll
POST /system/v4/media/preview
```

**Gap: 56 write routes have no parity case of their own, so they are not listed.** Go serves them, through the same handler as a listed module, but `validateGoRoutes` refuses a route without a case for that method and path, and these lists must pass it. Parity samples the writes instead of covering each module:

| Route | Has a case | No case |
| --- | --- | --- |
| `POST /api/{module}` | `eventos`, `demandas`, `buzon` | The other 13 |
| `PUT /api/{module}/{id}` | `compromisos`, `buzon` | The other 14 |
| `DELETE /api/{module}/{id}` | `compromisos`, `buzon` | The other 14 |
| `POST /system/import/{module}` | `compromisos` | The other 15 |

Add those cases before Wave E or G moves; do not loosen the check.

Ported but not on any list: `/login`, `/logout`, `/select-project`, `/hooks/ingest/{module}`, `/hooks/signals`, `/mcp` and `/auth/google/*`. They sit outside `/api/` and `/system/`, so `validateGoRoutes` refuses them. Moving them means changing that rule on purpose, after everything above.

## Container environment

`goContainerEnv` passes every setting the routes read, when it is set. What the reads need is enough for Waves A to D; the write waves also need the rest set on the Worker ([go-live list](go-trial-runbook.md#go-live-list-names-never-values)).

| Variable | Passed | Needed by these reads | Note |
| --- | --- | --- | --- |
| `SIPGES_HOST`, `SIPGES_PORT` | yes | yes | |
| `SIPGES_DATABASE_URL` | yes, from `SIPGES_GO_DATABASE_URL` | yes | Without it Go refuses to start. |
| `SIPGES_ALLOWED_HOSTS` | yes | yes | **Unverified:** that the container sees the public `Host`. The library forwards the original URL (`container.js:886`); only the trial proves it. |
| `SIPGES_TRUST_CF_CONNECTING_IP` | yes | no | |
| `SIPGES_CRON_SECRET`, `CRON_SECRET`, `SIPGES_CRON_SCHEDULE` | yes, when set | no | For `/system/automations/runtime`. Inert while `SIPGES_GO_AUTOMATION_CRON` stays out, as it does. |
| `SIPGES_REQUIRE_MFA` | yes, when set | yes | Go defaults to on, as production should. **Unverified:** that production does not override it. Secrets need the owner to read. |
| `SIPGES_DATA_KEY` | yes, when set | no | A working Worker always has it, because TypeScript requires it. Without it Go still starts, but TOTP answers 404 or 500. |
| `SIPGES_STORAGE`, `SIPGES_S3_*` | yes, when set | no | Unset, uploads answer 500 (L37). Required before any upload route moves. |
| `SIPGES_COOKIE_SECURE` | yes, when set | no | Reads set no cookie; unset means `Secure`. |
| `SIPGES_GOOGLE_*` | yes, when set | no | Unset, the sign-in stays hidden. This is why `/system/auth/providers` is not proposed yet. |

## What must be true first

Before the trial on `sipges-go`:

- [x] B5 and B6 fixed on `main`, so the trial exercises the failure path production will have.
- [x] `SCREENS` aligned with the real first paint.

During the trial:

- [ ] `sipges-go` deployed with `instance_type: "basic"`, `regions: ["ENAM"]`, `sleepAfter: 10m`.
- [ ] Secret `SIPGES_GO_DATABASE_URL` set with `sslmode=verify-full`, on the same login role the Hyperdrive of that environment uses, never a superuser or `BYPASSRLS` role. Pool size comes from `pool_max_conns` in the URL; pgx's default was not measured under load.
- [ ] A session issued by TypeScript on Workers is accepted by a Go-routed route on `sipges-go`, with TOTP, and the Secure cookie reaches the container.
- [ ] A session expired or revoked in TypeScript gets 401 from Go on the next request.
- [ ] Rollback rehearsed on `sipges-go` and timed.
- [ ] B2 and B3 measured and passed.

Before the first production entry:

- [ ] B1 to B6 cleared, and B7 cleared or accepted in writing by the owner.
- [ ] `SIPGES_GO_ROUTING=1` set only in the change that adds the first entries.
- [ ] Proposed entries copied by wave, `go-routing.test.ts` green with the real list.

### Rollback

These routes only read, so rolling back leaves no data to reconcile.

| Scope | Action | Time |
| --- | --- | --- |
| One route or wave | Remove its entries, deploy. | **Unverified**, one deploy. |
| Everything | Unset `SIPGES_GO_ROUTING`, deploy. | **Unverified**, one deploy. |
| A bad deploy | `wrangler rollback`, as `deploy-workers.yml` does. | **Unverified** with a container attached. |

Editing the variable in the dashboard is not a lasting rollback: the next deploy restores what the repository says.

## Measurement with the owner

Run from Lima with the synthetic load account, on the same day, the same Neon branch and the same Worker, with the routes off and then on. A route list for the trial lives on an unmerged branch.

```bash
cd apps/api
SIPGES_LOAD_BASE_URL=https://<sipges-go host> SIPGES_LOAD_SCOPE=<tenant/project> \
  pnpm run bench:prod-screens -- --env-file ~/.config/sipges-carga.env --label <off|on> --out <file>.json
```

Per-route figures are in the `--out` JSON under each step's `path`; the console prints only the four slowest.

| What | How | Pass |
| --- | --- | --- |
| Screen p50/p95, 8 screens | `screen` in the JSON | Proposed: no worse than the baseline of step 2 on each screen. Owner to confirm. |
| p50/p95 per route | `path` in the JSON, off against on | Proposed: no listed route slower with Go. |
| Query to Neon from the container | Inside the container, as in T2 | Warm p50 ≤ 35 ms, p95 ≤ 45 ms (S8). Otherwise Fly.io `iad`. |
| Cold start | First request after more than 10 min idle, five samples | ≤ 3 s (S8). |
| Errors | `statuses` in the JSON | 0. |
| Memory | `containersMetricsAdaptiveGroups` in Cloudflare's GraphQL Analytics, max and `memoryP95` | Below `GOMEMLIMIT=800MiB`, measured for the first time under real load. |

Three things to read carefully:

- **The baseline is new.** `SCREENS` in `apps/api/bench/prod-screens.ts` now sends the real first paint: the shell on every screen, exact URLs, `X-SIPGES-Scope` on data calls, and a `Registros lista` screen. So the figures from L19 no longer compare with a run of this script: take the production baseline again before the first run on `sipges-go`, and read the pass column against that baseline.
- **Go may lose on single-query routes.** Today each query crosses Lima ↔ us-east-1 (about 121 ms, ADR 0032). With Go the whole request crosses once and queries cost 26–33 ms, so routes with several round trips should win and a route with one may not. Measure, do not assume.
- **Billing changes.** `/system/notifications` polls every 60 s, so with Wave A an open visible tab keeps the container awake past `sleepAfter`. Compare the usage estimate after the trial.

## Advisories that remain

None blocks the reads. Check them when reading the trial's results.

| Advisory | Source | Effect |
| --- | --- | --- |
| Go's grant cache ignores revokes made in TypeScript. | L13 | A revoked project stays readable up to 30 s, the same window as between isolates. |
| Stored legacy `50.0` keeps its spelling. | L24 | Same JSON value, different bytes. |
| `strings.ToLower` differs from JavaScript on letters like `İ`. | L25 | Closed statuses only, so none today. |
| Parity runs TypeScript on Node; production runs it on Workers. | L41 | **Unverified** for these reads. |
| Go has no pending-migrations check. | `index.ts` | Migrations are additive, so an older image keeps working; a non-additive one would not be caught. |
| Go-routed requests skip the Worker's access log and `/system/metrics`. | `go-proxy.ts` | Go logs its own. The Worker's request id does not reach Go, and Go's replaces it on the response, so the two logs do not correlate. |
| Container placement moves between Toronto, Miami and Atlanta. | L5 | Compare runs knowing that. |

## Order of work

1. Clear B5 and B6, and align `SCREENS`, in code PRs that change no route.
2. Take the production baseline with the owner.
3. Deploy `sipges-go` (B1) and work through the trial checklist.
4. Measure Wave A, then A+B, then A+B+C, then A to D on `sipges-go` (B2, B3).
5. Owner decides B7 and the go/no-go.
6. Add the production container (B4) with `GO_ROUTES` still empty, and confirm production is unchanged.
7. Switch Wave A alone, measure again, then B, then C, then D.
8. Owner decides on the [write waves](#proposed-writes-not-before-the-reads).

## Evidence

Local, 2026-11-05, Node 22.19, synthetic PostgreSQL 18.6. No deployment, no real data.

| Check | Result |
| --- | --- |
| `pnpm parity` at `3e6f60ff` | 1652/1652 |
| `pnpm parity` with `screens.ts` | 1888/1888; the 236 new cases answer 200 (140), 401, 403 and 404 (32 each) |
| Parity against Go started with `goContainerEnv` plus `SIPGES_REQUIRE_MFA=0`, from a read-only working directory | 1866/1888; 15 `POST /system/uploads`, 7 TOTP, none in `screens.ts` |
| Real Chromium through a local stand-in for the route table, all three waves on: 9 screens and one record | 82 answers from Go, 11 from TypeScript, 0 failures, 0 console errors; visible text identical to TypeScript alone on all ten |
| MFA on, both APIs, session without TOTP | 26/26 identical |
| `go-proxy.ts` with the library's failure responses | each becomes the JSON 503, with `X-Request-Id` (B5) |

The stand-in is not the Worker: it does not run `go-proxy.ts`, Durable Objects or the container. The browser visited `eventos`, `alertas`, `fuentes`, `demandas`, `buzon` and `lecciones` lists; the other modules are covered by parity only.

**Not verified:** anything on Cloudflare (Host forwarding, TLS with `verify-full` from this image, cold start with the engines, memory, latency, billing), production secrets, TypeScript on Workers against Go, real data, the image itself here (CI's `Go image` job builds it and checks `/health`).

## Sources

- [Cloudflare Containers: instance types](https://developers.cloudflare.com/containers/platform/limits/)
- [Querying Containers metrics with GraphQL](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-container-metrics/)
- [ADR 0032](../adr/0032-go-backend-rust-engines.md), [Go container guide](go-container.md), [benchmarks](../benchmarks/README.md)
