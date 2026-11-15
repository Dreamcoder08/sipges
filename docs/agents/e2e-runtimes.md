# E2E against the Go API

`apps/e2e` runs against the Node API by default. `SIPGES_E2E_RUNTIME` swaps the server behind the
same specs: unset or `node` (Node API, PGlite or PostgreSQL), `workers` (Cloudflare adapter under
`wrangler dev`) or `go` (`apps/api-go` serving the built SPA itself). Any other value fails at setup.

```sh
pnpm --filter @sipges/web exec vite build --emptyOutDir false
cd apps/e2e
SIPGES_E2E_RUNTIME=go SIPGES_E2E_DATABASE_URL=postgres://sipges_test@127.0.0.1:<port>/sipges_test \
  pnpm exec playwright test --project=chromium tests/06-csp-screens.spec.ts
```

With `go`, `global-setup.ts`:

1. builds `apps/api-go/cmd/api` once into a scratch directory (`mkdtemp`), before any database exists;
2. creates `sipges_e2e_go_<random>` on the server of `SIPGES_E2E_DATABASE_URL`, which must be a
   synthetic loopback server whose role can create databases; there is no PGlite in Go;
3. runs `sipges-api-go migrate` with `SIPGES_MIGRATIONS_DIR` pointing at the TypeScript API's SQL
   files (Go does not migrate on start);
4. starts Go on a free loopback port with `SIPGES_WEB_DIR=apps/web/dist`,
   `SIPGES_ALLOWED_HOSTS=localhost` (Go refuses to serve the SPA without it), the synthetic admin
   and data key of the run, MFA off, and `SIPGES_ALLOW_PRIVILEGED_DB_ROLE=1`, which Go accepts only
   on a loopback database. Tenant queries still switch to `sipges_tenant`, so row-level security applies;
5. waits for `/health/ready`, which turns 200 once the database answers and the admin exists;
6. on teardown stops Go, drops the database it created and removes the scratch directory.

The env is built by the pure helpers in `apps/e2e/support/runtime.ts` (tested in
`runtime.test.ts`); the launchers live in `support/server.ts`. Specs that start their own server
(`02-cookie-policy`, `03-mfa-required`) always start the Node API, whatever the runtime.

CI runs only the Node and WebKit jobs. A Go job would need the Go toolchain from
`apps/api-go/go.mod`, the PostgreSQL service the `e2e` job already has, the built SPA, and
`SIPGES_E2E_RUNTIME=go` on a chosen spec list.
