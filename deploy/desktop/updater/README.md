# Update a managed desktop install

Signed, local, recoverable updates of the package built by `deploy/desktop/package/builder.mjs`.
Nothing is published or downloaded: a release is a directory on this computer. Decisions are in
`odd/tasks/desktop-updates.md` (Design).

## Release

```sh
node deploy/desktop/updater/release.mjs --package .data/desktop-packages/sipges-1.2.3 \
  --out <new release dir> --key <Ed25519 private key, PKCS#8 PEM> [--minimum-previous 1.0.0]
```

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

## Limits

- Tested on Linux with synthetic data and injected migration and readiness. The CLI boot path and
  Windows (junctions, rename retries, process stop) have not been run.
- Reversing to the previous version restores the pre-update copy: records written after the update
  started are not carried back.
- The CLI does not detect a running SIPGES; stop it first. Startup integration and the update
  notice are desktop-updates T3.
- An old install that is a Git clone (no `metadata.json`) cannot be adopted; carrying its data is
  closure-roadmap T33.
