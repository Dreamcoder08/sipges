# Build a local desktop runtime

From the checkout, with dependencies installed, Node 24+ and pnpm available:

```sh
node deploy/desktop/package/builder.mjs --version 1.2.3 --out .data/desktop-packages/sipges-1.2.3
```

The output must be the new direct child `.data/desktop-packages/sipges-<version>` of this checkout, supplied as a relative or absolute path. The builder creates missing private parent directories and rejects existing targets and symlinked parents. The builder uses the current host platform and architecture; `--platform` and `--arch` can explicitly confirm them, but cross-builds are refused. It deploys production API dependencies and builds the web app, then compiles the deployed first-party TypeScript without changing source packages. Build prerequisites and Node are not included in the output.

The generated marker identifies a builder-owned output. A failed build is retained for diagnosis, not automatically deleted. `metadata.json` records the version, platform, architecture, Node minimum and supported entry. Run `node start.mjs` with the required installation configuration and `SIPGES_WEB_DIR` set to the absolute `web` directory. Keep application state outside the package. This directory is not a signed release or an updater; feeds, signing, migration recovery and distribution are deferred.

## Reference data

The supported entry defaults `SIPGES_REFERENCE_DIR` to the package's initially empty `references` directory. No project data is packaged. An operator may explicitly set `SIPGES_REFERENCE_DIR` to an absolute directory containing `project_coordinates.json` and `canonical_entities.json`; each file must satisfy its API contract. Missing files are unavailable, not empty data. Symlinks and non-regular files are rejected. This is not a guarantee against concurrent malicious replacement by a process with the same filesystem privileges; Windows does not provide the same no-follow open flag. Do not run `api/src/main.js` directly for a managed installation, because that bypasses the managed default.
