# Build a local desktop runtime

From the checkout, with dependencies installed, Node 24+ and pnpm available:

```sh
node deploy/desktop/package/builder.mjs --version 1.2.3 --out .data/desktop-packages/sipges-1.2.3
```

The version is the one `/health` reports: without `--version` it is the root `package.json` version,
and a release version (no pre-release tag) must equal it, build metadata aside (`1.2.3+visit.2`);
another one is refused before anything is written. A pre-release (`1.2.3-rc.1`, the drills'
`0.0.7-drill.…` and `0.0.8-kit.…`) marks a rehearsal and is accepted as given.

The output must be the new direct child `.data/desktop-packages/sipges-<version>` of this checkout, supplied as a relative or absolute path. The builder creates missing private parent directories and rejects existing targets and symlinked parents. The builder uses the current host platform and architecture; `--platform` and `--arch` can explicitly confirm them, but cross-builds are refused. It deploys production API dependencies and builds the web app, then compiles the deployed first-party TypeScript without changing source packages. Build prerequisites and Node are not included in the output.

The generated marker (`.sipges-desktop-package`, written first) identifies a builder-owned output; `.sipges-package-complete`, written last, marks a build that finished. A failed build (the marker without the completion file) is retained for diagnosis, not deleted by the builder; the visit kit (`deploy/desktop/windows/visit-kit.mjs`) removes only such a failed folder of its own checkout and version before retrying, and refuses a finished one. `metadata.json` records the version, platform, architecture, Node minimum and supported entry. Run `node start.mjs` with the required installation configuration and `SIPGES_WEB_DIR` set to the absolute `web` directory. Keep application state outside the package. The package also carries `updater/` (signed release check, update and the `launcher.mjs` startup with the update notice) and marks `web/index.html` with `<meta name="sipges-desktop">`, which is what makes the web app ask for the notice. This directory is not a signed release; `deploy/desktop/updater/` signs it as a local release and installs or updates it with rollback (see its README). Feeds and distribution are deferred.

## Go mode (opt-in)

`--go` adds the Go mode beside the TypeScript runtime: `go/sipges-desktop`, `go/api` (built from
`apps/api-go` with the Go toolchain of the build computer) and `go/migrations`, and on Windows x64
`postgresql/`: the pinned PostgreSQL 18 from [`../postgresql`](../postgresql/pg18.json), downloaded
once into `.data/postgresql`, used only when its SHA-256 matches the pin, and trimmed to `bin`, `lib`,
`share` and the licences. `metadata.json` then records `go` (entry, API, migrations and the
PostgreSQL version and SHA-256); `entry` stays `start.mjs`. Without network and without a verified
copy in the cache the build fails with a message that says so. On other platforms no PostgreSQL is
bundled and the Go mode needs `SIPGES_PG_BIN`. Without `--go` nothing of this is built, read or
downloaded. See [../README.md](../README.md#go-mode).

## Reference data

The supported entry defaults `SIPGES_REFERENCE_DIR` to the package's initially empty `references` directory. No project data is packaged. An operator may explicitly set `SIPGES_REFERENCE_DIR` to an absolute directory containing `project_coordinates.json` and `canonical_entities.json`; each file must satisfy its API contract. Missing files are unavailable, not empty data. Symlinks and non-regular files are rejected. This is not a guarantee against concurrent malicious replacement by a process with the same filesystem privileges; Windows does not provide the same no-follow open flag. Do not run `api/src/main.js` directly for a managed installation, because that bypasses the managed default.
