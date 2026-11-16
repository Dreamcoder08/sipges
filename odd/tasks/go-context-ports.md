# Go context ports (T10 of functional-closure, in Go)

Contexts in `apps/api-go` stop writing other contexts' tables (ADR 0002, functional-closure S10). Base `main` at `5a24412c`;
branch `feat/go-context-ports`; delivery `auto-chain`, one work-unit commit per task; runner `go test -race ./...` with
`SIPGES_TEST_DATABASE_URL` from `scripts/agents/test-pg.sh` (`TZ=UTC PGTZ=UTC`), plus `pnpm parity`.

## Specs

- S1 — functional-closure S10, verbatim: «Architecture: contexts stop writing other contexts' tables (ADR 0002) and the duplicated `module_records` readers become one port; semantic intelligence reports when no embedder is reachable.» Its T10: «command ports for `module_records`, `automation_cursors` and `audit` writes; one records reader port.»
- S2 — Owner, 2026-11-15: «perfect avanza quiero todo 10/10 y estar en la vanguardia sigue el flujo ODD»; «yes te autorizo todo , confirmo y avanza con cada una».
- S3 — Scope is Go only (ADR 0032 §6: the TypeScript API is frozen until its retirement; changing it would only move parity). Assumption, recorded in L2.
- S4 — Behaviour does not change: every stored value (column, normalization of `detail`, `event_payload`) and every HTTP answer stays byte-identical; the existing integration tests and `pnpm parity` prove it. Each write stays in the caller's tenant transaction.
- S5 — Cross-context calls follow the existing pattern: the owning context exports an application-level interface or function taking a `database.Querier`; the composition root (`internal/app`) wires adapters; no context imports another's `infrastructure` (as `reviewRecordsPort`, `internal/app/context_documents.go:59-64`).

## Tasks

- T1 [ ] — S1, S4, S5: one audit appender owned by `internal/audit`, used by the 12 non-identity writers; each caller keeps its own `detail` normalization; intelligence passes `event_payload`. Route: inline. Risk: none beyond S4 (no identity). Commit: pending.
- T2 [ ] — S1, S4, S5: identity's two audit writes (sessions, MFA reset) through the same appender. Route: inline. Risk: item 2 (identity), own commit and independent verifier. Commit: pending.
- T3 [ ] — S1, S4, S5: `records` exports in-transaction payload and marking setters; `evidence` (payload) and `ontology` (marking) use them instead of writing `module_records`. Route: inline. Commit: pending.
- T4 [ ] — S1, S4, S5: `automation` exports the "start cursor if missing" write with integration's `ON CONFLICT DO NOTHING` semantics; `integration` uses it. Route: inline. Commit: pending.
- T5 [ ] — S1, S5: one records reader for the shared lookups (by `(module,id)` with marking: analyst, ontology; existing ids: documents). The context-specific read models (ontology search, dates and embeddings, privacy names, situations, indicators, intelligence, analytics, geography, management) are listed with a keep-or-port verdict. Route: inline. Commit: pending.

## Log

- L1 (Request): 2026-11-15. Owner, verbatim: «perfect avanza quiero todo 10/10 y estar en la vanguardia sigue el flujo ODD», then «yes te autorizo todo , confirmo y avanza con cada una» for the open ODD tasks, functional-closure T10 among them.
- L2 (Map, read-only explorer on `main` 47aed826): 14 `INSERT INTO audit` in 13 contexts; 11 share `(tenant_id, ts, module, record_id, action, detail)`, intelligence adds `event_payload` (nullable, no default: migration 0021), identity hard-codes module/action. `detail` normalization differs: `WellFormed` (records, prevention, privacy, integration), `PGText` (automation), raw (the rest). Foreign writes: `evidence/infrastructure/attach.go:31` (payload), `ontology/infrastructure/writes.go:42` (marking), `integration/infrastructure/runtime.go:203` (cursor start, `DO NOTHING`, unlike automation's `DO UPDATE … GREATEST`). `internal/audit` has only a reader. Decision (agent): Go only, because the TypeScript API is retired route by route (ADR 0032 §6).
