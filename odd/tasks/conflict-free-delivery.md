# Conflict-free parallel delivery

Stop parallel PRs (one per Go context or Rust engine) from conflicting with each other, and turn the steps repeated
on every port into repository skills. Branch `chore/conflict-free-delivery` from `main`; delivery `auto-chain`
(one PR per unit, merged after CI); runners `go test`, Vitest, `node --test scripts/tooling.test.mjs`.

## Specs

- S1 — «usa buenas practicas de git y github para que no vuelvan a haber conflictos , consulta informacion actualizada de la web»
- S2 — «ademas en base a todo lo que hacemos , crea skills , para automatizar todo lo repetitivo o que se hace mas de 2 veces»
- S3 — A context ported to Go registers its routes from a file of its own (`apps/api-go/internal/app/context_<name>.go`); no PR adds lines to a list another PR also edits.
- S4 — Parity cases are discovered from `apps/parity/src/contexts/*.ts`; adding a context never edits `contexts/index.ts`.
- S5 — Append-only logs (`odd/tasks/*.md`, `CHANGELOG.md`) merge with git's built-in `union` driver on local merges, and CI fails on a duplicated log or task id.
- S6 — Shared documents (feature document Tasks/Log, READMEs) have one writer: parallel workers report their entry in the PR description, and the orchestrator records it after the merge.
- S7 — Each skill automates a flow done more than twice, with that evidence recorded in `docs/agents/skills.md`.

## Tasks

- T1 [x] — S3, S4: per-context Go registration files and parity auto-discovery, with tests. Route: inline. Commit 26fcee1.
- T2 [x] — S5: `.gitattributes` union merge for append-only logs and a CI check for duplicated ids. Route: inline. Commit d2dd082.
- T3 [x] — S6: document the single-writer rule (AGENTS.md, `docs/agents/parallel-delivery.md`). Route: inline.
- T4 [ ] — S2, S7: skills `sipges-go-port`, `sipges-rust-engine`, `sipges-parallel-agents` and a "land" step in `sipges-task-pr`. Route: delegated (parallel unit, disjoint surface `.agents/skills/**`, `docs/agents/skills.md`).

## Log

- L1 — Request (2026-11-03), verbatim: «usa buenas practicas de git y github para que no vuelvan a haber conflictos , consulta informacion actualizada de la web ademas en base a todo lo que hacemos , crea skills , para automatizar todo lo repetitivo o que se hace mas de 2 veces».
- L2 — Evidence: PRs #217, #220 and #221 turned CONFLICTING three times each after #219, #222, #223 and #224 merged; every conflict was in `internal/app/app.go`, `apps/parity/src/contexts/index.ts`, READMEs or `odd/tasks/go-rust-stack.md` (Tasks and Log, including two `T8` and repeated `L16`).
- L3 — Research (2026-11-03): GitHub merge queue needs an organization-owned repository or Enterprise Cloud; this repository belongs to a personal account. GitHub ignores `merge=union` in pull request conflict checks and "Update branch", but local `git merge` honours it, and agents merge `origin/main` locally. Union is safe only for append-only files and can duplicate lines, hence the duplicate-id check. The structural fix is one file per entry.
- L4 — T1–T3 done. RED/GREEN: `go test ./internal/app` (registry, duplicate panic, failing context named), `node --test src/discover.test.ts` (new file found, index and tests skipped, module without `cases` rejected), tooling tests for `odd:check` and for a local union merge of two log appends; app, audit, prevention, situations and reference Go packages pass against the synthetic PostgreSQL. Seed order is now file-name order (reference before situations); CI parity confirms it. T4 runs in tab `skills` (branch chore/skills-repeat-flows).
