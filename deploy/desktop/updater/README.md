# Update a managed desktop install

Signed, local, recoverable updates of the package built by `deploy/desktop/package/builder.mjs`.
Nothing is published or downloaded: a release is a directory on this computer. Decisions are in
`odd/tasks/desktop-updates.md` (Design).

## Release

```sh
node deploy/desktop/updater/release.mjs --package .data/desktop-packages/sipges-1.2.3 \
  --out <new release dir> --key <Ed25519 private key, PKCS#8 PEM> [--minimum-previous 1.0.0] \
  [--notes "Qué cambió, en texto plano"]
```

`--notes` (optional, at most 4000 characters) is signed inside `release.json` and shown in the
update notice under «Qué cambió».

The release holds `package/` (a copy of the build, plus `update-public-key.pem` derived from the
signing key), `release.json` (version, minimum previous version, platform, SHA-256 of every file,
internal directory links, directories) and `release.sig` (Ed25519 signature of the exact
`release.json` bytes). Keep the private key off the laptop and out of the repository.

## Install, update, recover

Stop SIPGES first: the state folder must not change while it is copied.

```sh
# First install: the operator supplies the public key once.
node deploy/desktop/updater/update.mjs --install <root> --release <dir> --state <state dir> --trust-key <public.pem>
# Later updates: verified with the key inside the installed version.
node deploy/desktop/updater/update.mjs --install <root> --release <dir>
# Old plain package directory (no versions/): adopted where it is, state folder not moved.
node deploy/desktop/updater/update.mjs --install <new root> --release <dir> --adopt <old package> --state <state dir> [--trust-key <public.pem>]
# After a crash or power cut during an update.
node deploy/desktop/updater/update.mjs --install <root> --recover
```

Exit codes: 0 done, 1 refused or invalid, 2 failed and rolled back, 3 rollback incomplete (run
`--recover`; the pre-update copy is named in the message).

Layout of `<root>`: `versions/<version>/` (verified copies; files are copied, never hardlinked),
`current.json` (the pointer, replaced by one atomic rename), `install.json` (state folder),
`update.log` (JSON lines), and while an update runs `update.lock` and `update-journal.json`.

An update refuses a bad signature, any file that differs from the signed list, an unlisted or
missing file, a version that is not newer, a release that needs a newer installed version and
another platform. Then it copies the state folder beside itself as
`<state>.pre-update-<UTC time>-<from>-to-<to>`, migrates (the CLI boots the new `start.mjs` on a
free loopback port; the API migrates at boot), switches the pointer and checks readiness
(`/health/ready` and the web shell). A failed migration or readiness check switches back and
restores the state folder from the pre-update copy; the changed folder is kept as
`<state>.failed-<time>-<to>`. The first update of an adopted install first runs migration and
readiness on `<state>.rehearsal-<time>-<to>` and does not touch the state folder if that fails.

The updater never deletes the copies it makes. They hold the same data as the state folder,
including `data-key` and `admin-password`: treat them like the backup.

## Start SIPGES and the update notice

The package carries this folder as `updater/`. Start a managed install with the launcher of
any installed version (it always runs the current one):

```sh
node <root>/versions/<version>/updater/launcher.mjs --install <root> --releases <release source> [--port 8000]
```

1. It recovers an update interrupted by a crash, prepares the state folder (creates a missing
   `data-key` or `admin-password` once, never rewrites one) and starts the current version on
   `127.0.0.1`.
2. Beside it, never delaying it, it checks the release source once: one release directory or a
   folder of them. Only `release.json` and `release.sig` are read; a release counts when its
   signature matches the key of the installed version and it is newer (minimum previous version
   and platform as for an update). The result is one JSON line, `update_check` or
   `update_check_failed` (missing folder, a check slower than 10 s, no update key).
3. The app shows administrators «Nueva versión de SIPGES», the release notes, «Actualizar» and
   «Ahora no». «Ahora no» hides it until the next start. Nothing is copied or installed before
   «Actualizar».
4. After the click the launcher stops SIPGES, runs the same update as `update.mjs` (verified
   again, pre-update copy of the state folder, migration, readiness, rollback on failure) and
   starts the resulting version on the same port. The page reloads itself, or says the update
   failed and which version is still running.

The launcher and the API share `<root>/update-channel/` (`SIPGES_DESKTOP_UPDATE_DIR`):
`status.json` (written by the launcher) and `request.json` (written by the API after the
click). A request only names a version: the launcher applies the release it verified for that
version and ignores anything else, and drops any request left from an earlier run. Without
`SIPGES_DESKTOP_UPDATE_DIR` (cloud, development clones) the routes do not exist, and only the
packaged web app (marked `<meta name="sipges-desktop">` by the builder) asks for them.

Backups: every update leaves `<state>.pre-update-<time>-<from>-to-<to>` beside the state folder;
copy the state folder yourself before the first update, as in `deploy/desktop/README.md`.
Failure: a failed update rolls back by itself and the previous version starts again; after a
power cut the next start (or `update.mjs --recover`) finishes the rollback.

## Limits

- Tested on Linux with synthetic data and injected migration and readiness. The CLI boot path and
  Windows (junctions, rename retries, process stop) have not been run.
- Reversing to the previous version restores the pre-update copy: records written after the update
  started are not carried back.
- `update.mjs` does not detect a running SIPGES; stop it first. The launcher stops its own
  server before an update. Shortcuts and the browser window still point at the clone-based
  launchers in `deploy/desktop/linux` and `windows`; switching them to `launcher.mjs` is open.
- The launcher was run end to end on Linux only; on Windows stopping the server is a hard stop.
- An old install that is a Git clone (no `metadata.json`) cannot be adopted; carrying its data is
  closure-roadmap T33.
