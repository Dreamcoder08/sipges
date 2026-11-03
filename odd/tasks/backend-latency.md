# Backend latency

Cut the database round trips each API request pays (Lima ↔ us-east-1, about 130 ms each) and remove
cross-request hangs. Branch `perf/backend-hotspots`; delivery `ask-on-risk`; runner `vitest` (PGlite).

## Specs

- S1 — «eres senior ingenerio de backend , usa buenas practicas senior de backend , calidad de codigo , arquitectura limpia , refactorizacion , modularidad , patrones y mas buenas practicas que hay en la web , el gran objetivo es correjir los problemas de carga , lentitud , paralelismo y mas en el proyecto»
- S2 — «al terminar has commit + push + buenas practicas de git + github + deploy todo en automatico»
- S3 — No request waits on work started by another request: only settled values are cached across requests, and an older result never replaces a newer one.
- S4 — Entering a tenant transaction costs one round trip instead of three, with the same settings (`app.tenant_id`, `app.actor`, `app.clearance`) and role `sipges_tenant`, and no SQL injection through those values.
- S5 — The activity stream does not run a tenant transaction every 3 s per open tab.
- S6 — Notifications return the unread count and the list from one transaction.
- S7 — `/api/registros/summary` returns rows and totals from one statement (totals stay on every page: the response contract is unchanged).
- S8 — «despues haces pruebas de estres , y mas se obsesivocritico»
- S9 — «okey te autorizo y continua con todo» (after the plan: Worker cold start, typed parameters, session/grants, bootstrap endpoint, whole-module loads, GIN search, batched inserts).

## Tasks

- T1 [x] — S3: settled-only caches for the geography catalogue, embedder probe and concept vectors. Route: inline. Commit: 28a7b90 (native review approved, reliability lens).
- T2 [x] — S3: generation guard so a late lookup does not overwrite a newer cache entry (review advisories). Route: inline. Commit: 1af23cd.
- T3 [x] — S4: one statement in `enterTenant` (`set_config` for settings and role, escape-string literals). Risk: item 2. Route: inline + independent verifier (PASS, 42 hostile values with `standard_conforming_strings` on and off). Commits: e2fc805, adb2e3c.
- T4 [x] — S5: activity stream polls every 10 s (ADR 0014 «every few seconds»). Route: inline. Commit: a890617. Exception: tuning constant, no RED test; realtime tests keep explicit `pollMs`.
- T5 [x] — S6: notification inbox in one transaction and statement. Route: inline. Commit: da1f758.
- T6 [x] — S7: records summary page and totals in one query. Route: inline. Commit: e7d0f12.
- T8 [x] — S1: web asks for session and active project together. Route: inline. Commit: 947e671.
- T9 [x] — S3, S9: Worker caches only a settled initialization (ported from the abandoned `delivery-readiness` worktree). Risk: items 4, 5. Route: inline + independent verifier (PASS). Commit: 1e8faf3.
- T10 [x] — S9: record import with one insert per 500 rows, repeated ids folded in order. Risk: real-data import tool. Route: inline + independent verifier. Commit: c21752c.
- T11 [x] — S3: automation ticks never await another request's tick; writes during a tick ask for one rescan (verifier advisory on T9). Risk: item 4. Route: inline + independent verifier. Commit: 7f17f72.
- T12 [x] — S8: `bench/latency-stress.ts`, base vs branch at 130 ms RTT. Route: inline. Commit: ad1beb7.
- T13 [x] — S3: tick rescans capped at 2 and a tick older than its budget replaced (verifier and native-review advisories). Route: inline. Commit: 5776266.
- T14 [x] — Review advisories: summary order/totals pinned (same result on main), batched import and concurrent ticks covered on real PostgreSQL. Commits: fe7f9bb, 3c40972.
- T15 [x] — Pre-existing, high severity, found by the T11 verifier: an audit row that commits after a higher id was scanned was never scanned. Fix: the cursor only passes events older than a 60 s settle window; newer ones are read again and their runs stay unique (`automation_runs` per rule, audit id and step). RED reproduced the loss deterministically. Route: inline. Commit: see below.
- T7 [ ] — Pending, with tradeoffs: typed query parameters (removes the describe trip; needs a per-query review), session + grants cache (identity, revocation delay — owner decision), web bootstrap endpoint and Bandeja server summaries, Inicio/Bandeja whole-module loads, GIN search (changes substring to word matching — owner decision).

## Log

- L1 — Original request (2026-11-02): «eres senior ingenerio de backend , usa buenas practicas senior de backend , calidad de codigo , arquitectura limpia , refactorizacion , modularidad , patrones y mas buenas practicas que hay en la web , el gran objetivo es correjir los problemas de carga , lentitud , paralelismo y mas en el proyecto»
- L2 — Mid-turn (2026-11-02): «al terminar has commit + push + buenas practicas de git + github + deploy todo en automatico»
- L3 — Audit (read-only, code reading, not timed): postgres.js `sql.unsafe(text, params)` without prepare costs 2 trips per parameterized query; `withTenant` adds BEGIN, `set_config` (2), `SET LOCAL ROLE` (1) and COMMIT; session and grants lookups run one after the other on every request; `/system/events` polls a tenant transaction every 3 s; notifications open two transactions; the summary awaits rows then totals and recomputes totals on every 500-row page.
- L4 — Mid-turn (2026-11-02): «despues haces pruebas de estres , y mas se obsesivocritico»; then «okey te autorizo y continua con todo».
- L5 — Stress evidence (local, synthetic, PostgreSQL 18 behind a 130 ms RTT proxy, `node bench/latency-stress.ts`, base 74a2046 vs branch, 0 errors both). Shared pool 5: throughput 2.4→3.1 req/s (1 screen), 3.0→4.3 (8), 3.1→4.4 (32); `/system/v4/settings` p95 1428→1166 ms (1 screen). Pool 20 (Hyperdrive origin limit): 10.3→15.7 req/s (8 screens), 12.1→17.5 (32); settings p95 4504→2753 ms (8). Limit: one process shares one pool; the Worker opens a client per request, so absolute queueing differs; relative gains hold.
- L6 — Verifier advisories kept as follow-ups: pending migrations are checked only until a backend is cached per isolate (pre-existing); `bootstrapGoogleAdmin` read-then-write race at cold start (pre-existing, tiny window).
- L7 — Native review of the whole branch (reliability lens): approved, receipt burned; advisories closed by T13/T14. Verifiers: T10 PASS (17 differential scenarios identical to main), T11 PASS (no duplicate queue/delivery under concurrent ticks on real PostgreSQL).
- L8 — Production after deploying #197 (Deploy Workers success on 365b8a0), same authenticated read-only script and synthetic load account as the v1.1.0 baseline, 20 s per step, 0 errors both: 8 screens served 286→383 requests (+34 %); Inicio p50/p95 2415/3133→1764/2100 ms; Registros 2264/2961→1415/1835 ms; notifications p95 2936→1848 ms. The 1-screen step has too few samples and its first Inicio includes the cold start after deploy. `/system/auth/me` stays ~0.4–0.5 s (session and grants lookups, T7).
- L9 — T15 side effect accepted: a rule created now can match events from the last 60 s that had not settled; before, it already matched any event the cursor had not reached. No duplicates: runs are unique per rule, audit id and step.
