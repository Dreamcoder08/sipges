---
name: sipges-go-port
description: "Use when the read routes of one SIPGES TypeScript API context (apps/api/src/contexts/<ctx>) must be ported to the Go backend in apps/api-go with parity cases. Write routes are out of scope unless trivial."
---

# Port a context's read routes to Go

One context per branch and PR (`feat/go-<ctx>` from `origin/main`). Read first: `apps/api-go/README.md`,
`apps/parity/README.md`, the context in `apps/api/src/contexts/<ctx>` (routes, application, domain,
repositories) and its row in `odd/tasks/go-rust-stack.md`. Never touch another context's files.

## Steps

1. **Inventory.** List the context's `GET` routes from its TypeScript router: path, role gate, query
   parameters and their validation (422 bodies), tables read, and whether rows are tenant scoped. A
   write route joins only when it is trivial (no audit, no side effects); otherwise list it as staying in
   TypeScript.
2. **Layout.** `apps/api-go/internal/<ctx>/{domain,application,infrastructure,http}`: pure rules in
   `domain`, use cases with a store interface in `application`, pgx queries in `infrastructure`,
   handlers and `Routes`/`Register` in `http`. Copy the shape of `internal/situations` or
   `internal/prevention`.
3. **Reuse the request pipeline, never reimplement it.** Session, Origin, MFA, project scope and role
   gates already run in `internal/app` (#216). Handlers read tenant data only through
   `tenancyhttp.WithRequestTenant(r, pool, fn)` (it calls `database.WithTenant` with the resolved
   project, actor and clearance). Errors use `internal/platform/httpx` (`{"detail": …}`); query and path
   reading use its Hono-compatible helpers.
4. **Byte-identical output.** When TypeScript formats numbers, cuts strings or sorts, port the
   JavaScript semantics: `String(number)`, `Math.round`, UTF-16 lengths and ordering, `trim`/`\s`,
   `localeCompare`. Reuse the helpers in `internal/situations/domain/js.go` and `text16.go` before
   writing new ones; record TypeScript outputs on synthetic inputs (`testdata/generate.mjs` with
   `--check`) and pin them in a Go test.
5. **Register the routes from a file of their own:** `apps/api-go/internal/app/context_<ctx>.go`
   (spec S3 of `odd/tasks/conflict-free-delivery.md`). Follow the registration hook that file pattern
   uses in `internal/app`; do not add lines to a list another PR also edits. If the hook has not landed
   on `main` yet, add one call next to the other contexts in `app.go` and expect an additive merge.
6. **Parity cases in a new file:** `apps/parity/src/contexts/<ctx>.ts` exporting `cases` (names
   prefixed with the context) and the synthetic `seed` SQL they read. Contexts are discovered from
   that directory (spec S4): never edit `contexts/index.ts`. Cover per route: a session, no session,
   `consulta`, an ungranted project (also `PARITY/OTRO`), `project_id` of another and of its own
   project, `multi` before choosing and in each project, trailing slash, `HEAD`, and every 422.
7. **Tenant isolation tests.** A Go integration test (`dbtest`) proving another project's rows stay
   invisible and that `consulta` never sees `restringido` records when the table has RLS.
8. **Worker routing stays off.** `GO_ROUTES` in `apps/hosting-cloudflare/src/go-routes.ts` stays
   empty; switching a route is the owner's decision. Report the routes ready to switch.

## Checks

```sh
cd apps/api-go && gofmt -l . && go vet ./... && golangci-lint run ./...
SIPGES_TEST_DATABASE_URL=postgres://sipges_test@127.0.0.1:55439/sipges_test go test -race -p 2 ./...
SIPGES_PARITY_DATABASE_URL=postgres://sipges_test@127.0.0.1:55439/sipges_test pnpm parity
```

The URLs name a local synthetic server (superuser `sipges_test`, no query string); never a real
database. Then `sipges-verify` and `sipges-task-pr`.

## Report

Routes ported, parity cases (count, all equal), write routes left in TypeScript, routes ready to
switch, and the context's Log entry for the orchestrator (in the PR description, spec S6).

Reference: [Codex skills](https://developers.openai.com/codex/skills/).
