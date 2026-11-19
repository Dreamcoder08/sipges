# PGlite → PostgreSQL 18 move without Node

Port the one-time desktop data move (`deploy/desktop/migration/pglite-to-postgres.mjs`) to Go, running PGlite's
WebAssembly in wazero, so a desktop install never needs Node. Branch `feat/pglite-move-go` per task from `main`;
delivery `auto-chain` (one PR per task, merged after CI with the owner's standing authorization); runner `go test`.

## Specs

- S1 — Owner, on porting `pglite-to-postgres.mjs` to Go: «yes confirmo y te autorizo»; earlier: «te autorizo todo y avanza de forma autonoma».
- S2 — Owner's choice among «Node portátil», «Go + wazero» and «Dejarlo así»: «Go + wazero» («Correr el WebAssembly de PGlite desde Go con wazero, sin Node en ningún lado. Primero una prueba de factibilidad (necesita reimplementar el entorno de Emscripten); varios días y resultado incierto.»).
- S3 — Feasibility gate first: Go opens a COPY of a synthetic PGlite 0.5.15 data folder with `pglite.wasm` in wazero and answers SQL through the PostgreSQL wire protocol. If it cannot, stop and bring the owner one decision; nothing else is built.
- S4 — Same guarantees as `pglite-to-postgres.mjs` (its header and `deploy/desktop/migration/README.md`): reads only a copy of the state folder, opens only a scratch copy of its `pglite` folder, restores in one transaction, compares source and target and rolls back on any difference, hashes the copy before and after, never prints values, exit codes 0 / 1 / 2, `--prepared` removes `pg18.pending-move` only after a committed move with no difference.
- S5 — Synthetic data only; the PGlite WebAssembly files are the pinned `@electric-sql/pglite` 0.5.15 ones, verified by hash.

Evidence before T1 (2026-11-19): `pglite.wasm` 0.5.15 is «PostgreSQL 18.6 (PGlite 0.5.15) on wasm32-unknown-emscripten, 32-bit»; a native PostgreSQL 18.7 refuses its folder: «The database cluster was initialized without USE_FLOAT8_BYVAL but the server was compiled with USE_FLOAT8_BYVAL.» `pglite.wasm` imports 122 `env` functions (Emscripten syscalls, `invoke_*`, `_emscripten_throw_longjmp`, `_dlopen_js`, `_dlsym_js`, sockets) and 13 WASI ones; `pg_dump.wasm` 48.

## Tasks

- T1 [x] (c46937a3, PR #548) — S3, S5: gate spike, `apps/api-go/internal/platform/pglitewasm`: boot `pglite.wasm` in wazero on a scratch copy of a PGlite-made synthetic folder, run `SELECT` over the wire protocol from Go, and list what dynamic loading (`plpgsql`) needs. Route: delegated (context backstop of the parent). Outcome: GO (L3).
- T2 [x] (5b063fcc, PR #549) — S4, S5: loopback wire-protocol endpoint over the wasm backend so the bundled native `pg_dump` 18 dumps the copy. Route: delegated (context backstop). Outcome: L4.
- T3 [x] — S4, S5: `sipges-desktop --move-pglite` (copy, dump, restore in one transaction, compare, `--prepared`), porting `pglite-to-postgres.mjs` and the comparisons of `tables.mjs` it uses, core in `internal/platform/pglitemove`. Route: delegated (context backstop). Outcome: L5; independent verifier pending (risk items 1 and 4).
- T4 [ ] — S1, S4: release bundle ships the pinned wasm files; installers, kit and runbook use the Go move; Node kept only for installs still on TypeScript. Route: decided after T1.

## Log

- L1 — 2026-11-19, owner: «yes confirmo y te autorizo» (port `pglite-to-postgres.mjs` to Go), then chose «Go + wazero».
- L2 — 2026-11-19: native PostgreSQL 18.7 refuses a PGlite 0.5.15 folder (float8 by reference, 32-bit); wazero is the only path without Node. Next: T1.
- L3 — 2026-11-19: T1 GO. `pglitewasm` runs `pglite.wasm` 0.5.15 in wazero 1.12.0 with no Node: a scratch copy of the synthetic folder answers `select count(*), sum(x) from t` = 2000 / 3001500 over the wire protocol (simple and extended), and the source tree hash is unchanged. The dist files are pinned by SHA-256. Catalog reads need no dlopen; running a plpgsql function asks for `plpgsql.so`, which is refused with an SQL error. SIPGES migrations create no extension (`vector` is `real[]`, `tsvector` is built in) and use plpgsql only in triggers, which a read-only dump never fires. Tests skip unless `SIPGES_PGLITE_DIST` and `SIPGES_PGLITE_PGDATA` are set. Open risks for T2: whole-message framing in the relay, SSLRequest → `N`, one connection at a time, extra ParameterStatus messages, COPY TO STDOUT untested; for T3: ~5 s per Open (wasm compile), `Log()` must not be echoed raw. Next: T2.
- L4 — 2026-11-19: T2 done. `pglitewasm.Serve` listens on 127.0.0.1 only. It frames whole messages, answers SSL/GSSENC with `N`, drops CancelRequest, refuses a second client (53300) and resets the single PGlite session between clients (Sync, ROLLBACK, DISCARD ALL). Native pg_dump 18.7, in plain (COPY) and `--inserts` modes, restores into a fresh PostgreSQL 18 with 2000 / 3001500 and a working `f()`; the source hash is unchanged. Open for T3: each reply is buffered whole (check the largest table's size), restore needs `psql` or a COPY parser, ~5 s per Open, grants and roles of the real schema with `--no-owner`. Next: T3.
- L5 — 2026-11-19: T3 written. `pglitemove.Run` plus `sipges-desktop --move-pglite`: the same order of steps, refusals, output lines and exit codes 0 / 1 / 2 as the JS. The first output line names the WebAssembly in Go. The dist is checked by SHA-256 instead of the pinned-pair check. The `install.json` state folder is also refused as an original. Output lines are sorted by name. pg_dump 18's `\restrict`/`\unrestrict` pair is stripped and any other meta-command is refused. No pgx, pg_dump or PostgreSQL log text is printed. The dist defaults to `<version>/go/pglite` (T4 must ship it there). It also fixed a T2 handover race (53300 right after the previous client left). Tests: a synthetic SIPGES-like schema (forced RLS, grants, plpgsql trigger, identity, generated column, view, comments); a clean move; a changed value rolls back; 13 lossy-structure cases; refusals. Not tested: a copy that changes mid-read, a full CLI run, Windows junctions. Next: independent verifier, then T4.
