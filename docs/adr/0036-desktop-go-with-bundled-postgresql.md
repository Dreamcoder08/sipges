# 0036 — Desktop install on the Go API with a bundled PostgreSQL 18

## Status

Accepted (2026-11-17). Amends [0032](0032-go-backend-rust-engines.md) §6: the TypeScript API is removed only after
the desktop install also runs on Go (go-rust-stack T72, T73).

## Context

The owner, 2026-11-17: «quiero el backend con full Go , con motores en rust , acepta la orden». ADR 0032 already
moves the backend to Go and removes the TypeScript API when the last route moves.

The desktop install on the client's Windows laptop runs `apps/api/src/main.ts` on PGlite, PostgreSQL compiled to
WebAssembly, with real data in `%LOCALAPPDATA%\SIPGES` (closure-roadmap S5, T26). Go cannot open a PGlite data
folder, so the desktop needs a PostgreSQL the Go API can reach, and the data must move without loss.

Facts read on 2026-11-17 (go-rust-stack L74):

- PGlite 0.5.15, pinned in `apps/api`, embeds PostgreSQL 18.6 as a 32-bit wasm32 build (its `node_modules`). Its
  data folder is not assumed readable by a native 64-bit server; only a logical dump is.
- postgresql.org says the EDB Windows binaries zip «is intended for users who wish to include Postgres as part of
  another application installer»; PostgreSQL 18 is current
  ([download/windows](https://www.postgresql.org/download/windows/)). `pg_ctl` runs a server in user mode without
  administrator rights; only `pg_ctl register` (a Windows service) needs them
  ([pg_ctl](https://www.postgresql.org/docs/18/app-pg-ctl.html)).
- `fergusstrange/embedded-postgres` v2.0.0 and v2.0.1 shipped on 2026-10-19, default to PostgreSQL 18.6.1 and test
  Windows AMD64 ([releases](https://github.com/fergusstrange/embedded-postgres/releases)); v2 is one month old and
  the contents of the binaries it fetches are not documented.
- `@electric-sql/pglite-tools` `pgDump` writes plain SQL with `--inserts`; 0.4.16 needs `@electric-sql/pglite`
  0.5.16 exactly ([pglite-tools](https://pglite.dev/docs/pglite-tools)).
- `deploy/desktop/migration/` already proves a move lossless (`snapshot.mjs`, `compare.mjs`, `tables.mjs`), as
  closure-roadmap T33 did.

## Decision

1. The desktop install runs the Go API (`apps/api-go`) against a PostgreSQL 18 server shipped with the installer:
   the EDB Windows x64 binaries zip trimmed to `bin`, `lib` and `share`, at a pinned minor version with its SHA-256
   recorded in the repository.
2. The Go launcher owns the server: `initdb` once with `--locale-provider=builtin --builtin-locale=C.UTF-8 --locale=C -E UTF8` (amended 2026-11-18: Windows has no `C.UTF-8` libc locale and initdb refused `--locale=C.UTF-8` on the Windows rehearsal), then
   `pg_ctl start` and `stop`, listening on `127.0.0.1` only, on a free port chosen at start, never 5432 by
   assumption. No Windows service and no administrator rights.
3. The server's data folder lives under `%LOCALAPPDATA%\SIPGES-datos\pg18`, never under a folder OneDrive may sync.
4. Data moves once, by a migrator that runs on a copy of the PGlite folder: it opens the copy with the exact PGlite
   and pglite-tools pair it pins, dumps it logically, restores into the new server, and proves the move with the
   existing comparison tools (tables and API snapshots: no difference). The original PGlite folder is never written,
   so going back to the TypeScript version stays possible until the owner retires it.
5. Node remains only inside that one-time migrator. The installed app needs no Node at run time.
6. Before the laptop, one rehearsal on Windows 11 as a standard user with Defender on: install, migrate a synthetic
   copy, compare, kill the app during a write, restart, and roll back.
7. Amended 2026-11-18, minor updates: a new PostgreSQL 18 minor reaches an existing install as a plain binary swap,
   with no step of its own. Each installed version carries its own `postgresql/bin`, and the launcher starts the
   shared `<state>/pg18` cluster with the current version's binaries (`resolveBins` and `startCluster` in
   `apps/api-go/cmd/sipges-desktop/managed.go`). `localpg` checks only the major version, both `PG_VERSION` and
   `postgres --version` (`inspectDataDir`, `checkBinaries`; `TestMajorVersionReadsPostgresVersionOutput` covers
   `18.7`). The cluster records no binary path. A rollback to the previous version works the same way:
   [minor releases](https://www.postgresql.org/docs/18/upgrading.html) "never change the internal storage format
   and are always compatible with earlier and later minor releases of the same major version number". The 18.7 pin
   waits until 2026-11-26. EDB's `postgresql-18.7-1-windows-x64-binaries.zip` was published on 2026-11-12, and
   `readPin` refuses anything less than 14 days old. Checked against the
   [18.7 release notes](https://www.postgresql.org/docs/18/release-18-7.html):
   - GIN: the only GIN index is `module_records_search` (`0012_record_search.sql`, a `tsvector` expression). The
     two GIN corruption fixes (VACUUM missing dead entries when one VACUUM needs several index passes, and posting
     tree deletion after an incomplete page split) say "REINDEX is recommended if you suspect this has happened".
     A desktop's tables are far too small to need several index passes. The parallel GIN build fix needs keys over
     65,535 bytes, but a `tsvector` lexeme is at most 2,047. No REINDEX is scheduled. If a search misses a record,
     check the index with `amcheck`'s `gin_index_check`, then run `REINDEX INDEX CONCURRENTLY module_records_search`.
   - No `bpchar` column (no unbounded `char` type) and no `gist_trgm_ops`/pg_trgm index, so those two REINDEX
     items do not apply. The desktop takes no incremental backups.
   - CVE-2026-16237 (`INSERT … ON CONFLICT` through views): the migrations create no views, so it does not apply.
     CVE-2026-120154 (ON CONFLICT target rows read by leaky quals before RLS): SIPGES upserts into tables with RLS
     (`module_records`, `notifications`, `project_settings`, `irsa_configs` and `source_import_settings` forced;
     `automation_cursors` enabled). None of these upserts has a `DO UPDATE … WHERE`, and the API runs no SQL written by
     users. The fix is still worth taking, which is why the pin moves on the first allowed day.

## Consequences

- The desktop and production run the same Go code and the same SQL against real PostgreSQL 18; PGlite stays only
  for TypeScript tests until T73.
- The installer grows by roughly 300 MB unpacked; the bundle must be checked for the Spanish full-text search
  configuration and every extension the migrations create.
- New work: go-rust-stack T72 (launcher, bundle, migrator, rehearsal), then T73 removes `apps/api`. The desktop
  update path (desktop-updates) must carry the PostgreSQL bundle and its pinned version.
- Unverified until the rehearsal: whether the VC++ runtime must be installed, antivirus interference with
  `postgres.exe` and `pg_wal`, and `pgDump` output against the real schema.

## Alternatives considered

- `fergusstrange/embedded-postgres` v2 with vendored binaries: lighter (about 25 MB) and with crash supervision, but
  one month old and with binaries whose contents are not documented. Revisit when it has a longer record.
- The EDB installer as a Windows service: needs administrator rights, a password prompt and a visible service; too
  much for a non-technical user.
- PGlite in a Node sidecar (`pglite-socket`): keeps Node at run time against the owner's order, single connection,
  documented mainly for development.
- Keeping the TypeScript API on the desktop: contradicts the order and leaves two backends to maintain.
