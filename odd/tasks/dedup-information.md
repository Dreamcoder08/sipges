# Deduplicate repeated information (code, tests, memory)

Remove real duplication found by a repo-wide audit; keep intentional duplication. Base `main` at `e490339c`; branch
`chore/dedup-parser-and-test-helpers`; runners `go vet ./...`, `go test ./...` in `apps/api-go`, `pnpm odd:check`.

## Specs

- S1 — «verificar duplicidad de informacion»
- S2 — «yes te autorizo todo has lo que haria gentleman buenas practicas de ingeneri de softwart y mas»
- S3 — The JSON body parser in `apps/api-go/internal/tenancy/http/body.go` duplicates `apps/api-go/internal/platform/httpx/json_body.go`
  (jscpd: 91 + 78 lines); a single implementation must remain, with identical observable behaviour.
- S4 — The 14 `routes_integration_test.go` files repeat `start`, `get` and `expect` (copies already drift: 3 variants of each);
  a shared helper replaces them without changing any assertion.
- S5 — Intentional duplication stays: the dark token block in `apps/web/src/app/styles/tokens.css` (media query plus `data-theme`).
- S6 — Committed `.engram/chunks` are history: no rewriting. Only report; the 69 `mascli` summaries are not pruned.

## Tasks

- T1 [x] — S3: unify the JSON parser in `httpx`, tenancy calls it. Risk: item 2 (auth/validation path). Route: inline, then independent verifier. Own commit.
- T2 [ ] — S4: shared HTTP test helper, migrate the 14 packages. Risk: item 6 (no PostgreSQL here, only compile + vet). Route: inline. Own commit.
- T3 [x] — S1, S5, S6: audit and report. See L2.

## Log

- L1 — «verificar duplicidad de informacion»; then «yes te autorizo todo has lo que haria gentleman buenas practicas de ingeneri de softwart y mas»
- L2 — Audit: odd ids, docs, ADRs clean; 2 identical Engram observations; jscpd 40 clones / 0.85 %. No local PostgreSQL (no pg_ctl), so DB integration tests cannot run here.
