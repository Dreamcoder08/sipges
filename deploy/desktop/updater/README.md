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
# First install: the operator supplies the public key once, or trusts the key that signed this
# release (--trust-release-key prints its SHA-256 fingerprint to compare; the installers use it).
node deploy/desktop/updater/update.mjs --install <root> --release <dir> --state <state dir> --trust-key <public.pem>
node deploy/desktop/updater/update.mjs --install <root> --release <dir> --state <state dir> --trust-release-key
# Later updates: verified with the key inside the installed version.
node deploy/desktop/updater/update.mjs --install <root> --release <dir>
# Old plain package directory (no versions/): adopted where it is, state folder not moved.
node deploy/desktop/updater/update.mjs --install <new root> --release <dir> --adopt <old package> --state <state dir> [--trust-key <public.pem>]
# After a crash or power cut during an update.
node deploy/desktop/updater/update.mjs --install <root> --recover
# Way out of a halt (exit code 3), after you restored the state folder from your own backup.
node deploy/desktop/updater/update.mjs --install <root> --recover --accept-restored-state
# The first start over existing data, in a terminal (the launcher does the same at its start).
node deploy/desktop/updater/update.mjs --install <root> --first-start
# The copies beside the state folder: list them, or remove those older than <days> whole days.
node deploy/desktop/updater/update.mjs --install <root> --copies
node deploy/desktop/updater/update.mjs --install <root> --remove-copies-older-than <days>
```

### The first start over existing data

The first start of an install (`firstStart` in `updater.mjs`; the launcher runs it before
anything else, `--first-start` runs it in a terminal) looks at the state folder once. A fresh
folder needs nothing. A folder that already holds a database, such as the one of a clone-based
install, is refused while its `data-key` or `admin-password` is missing or empty (nothing written);
otherwise it is copied beside itself as `<state>.pre-update-<UTC time>-first-start-<version>`,
the version boots once on a second copy `<state>.rehearsal-<time>-<version>` (the migration),
and only then on the state folder. A failure on the rehearsal leaves the state folder untouched;
a failure on the folder restores it from the dated copy (the changed one is kept as
`<state>.failed-<time>-<version>`); a crash in between is rolled back by the journal like an
update. Either way SIPGES does not start: the launcher logs `start_refused` with «SIPGES no se
inició: la versión nueva no pudo abrir los datos existentes. Sus datos no se tocaron. …» and
exits with code 1. When it succeeds, `first-start.json` in the install root records it and the
launcher logs `first_start` with the copy; later starts change nothing. Stopping the launcher
(SIGINT or SIGTERM, handled from its first line) during the first start ends and awaits the boot
child, restores the folder from the dated copy, logs `first_start_cancelled` and exits with code
0; the next start runs the first start again. Every boot child also watches a pipe from the
process that started it and ends when that process is gone, however it ended (a hard kill, or
Windows, where there is no SIGTERM), so the next start's recovery never restores a folder a boot
child still writes; a stop during the click's update ends its boot the same way and the update
rolls back. Carrying an older
install's data, with its rehearsal and comparison scripts: [../migration/README.md](../migration/README.md).

`--accept-restored-state` refuses while the state folder is missing, empty or a link. Otherwise it
makes the version from before the interrupted update current again, clears the journal and logs
`restored-state-accepted`; it never copies, moves or deletes anything in or beside the state
folder, so the copies left by the failed update stay for diagnosis.

Exit codes: 0 done, 1 refused or invalid, 2 failed and rolled back, 3 rollback incomplete (do
not start SIPGES; run `--recover` to retry, or restore the pre-update copy named in the message).

Layout of `<root>`: `versions/<version>/` (verified copies; files are copied, never hardlinked),
`current.json` (the pointer, replaced by one atomic rename), `install.json` (state folder),
`first-start.json` (written once by the first start), `update.log` (JSON lines: `installed`,
`adopted`, `updated`, `refused`, `failed` for an error before any change such as a full disk
while staging, `rolled-back`, `rollback-incomplete`, `recovered`, `restored-state-accepted`,
`first-start`, `first-start-failed`, `copies-removed`), and while an update or the first start
runs `update.lock` and `update-journal.json`.

The lock is created complete in one step (a hard link of a fully written file) and holds the
process id, a random token and a heartbeat rewritten every 10 s. A lock whose heartbeat is older
than 2 minutes, or whose process is gone, was left by a crash and is taken over, even if its
process id now belongs to another program; an empty or unreadable lock counts by its file time.

The state folder is recorded by its real path at install or adoption: a state folder given
through a link (or a Windows junction) records the folder it points to, so the pre-update copy
holds the data. An update refuses a state folder that is a link, or that holds a link or a special
file, and one without room beside it for the pre-update copy plus one restore (plus the rehearsal
copy for an adopted install); refusals change nothing.

An update refuses a bad signature, any file that differs from the signed list, an unlisted or
missing file, a `metadata.json` whose version differs from the signed one, a version that is not
newer, a release that needs a newer installed version and another platform. An adoption is
recorded only after its release passed these checks. Then it copies the state folder beside itself as
`<state>.pre-update-<UTC time>-<from>-to-<to>`, migrates (the CLI boots the new `start.mjs` on a
free loopback port; the API migrates at boot), switches the pointer and checks readiness
(`/health/ready` and the web shell). A failed migration or readiness check switches back and
restores the state folder from the pre-update copy; the changed folder is kept as
`<state>.failed-<time>-<to>`. The first update of an adopted install first runs migration and
readiness on `<state>.rehearsal-<time>-<to>` and does not touch the state folder if that fails.
The migration boot picks a free loopback port and closes it before the version binds it, so
another program can take it in between: a version that ends with `EADDRINUSE` is booted again on
another port, at most 5 times.

### The copies beside the state folder

The updater never deletes the copies it makes on its own. They hold the same data as the state
folder, including `data-key` and `admin-password`: treat them like the backup. `update.log`
records each one (`preUpdateCopy`, and `rehearsalCopy` on `first-start` and on the first
`updated` of an adopted install), and every start of the launcher counts them: the `started`
line carries `stateCopies: { count, bytes }` (null if they could not be read).

- `--copies` prints `Copies beside <state>: <count>, <bytes> bytes` and one line per copy (kind,
  time from its name, bytes, path), oldest first. Only finished folders named
  `<state>.pre-update-<time>…`, `.rehearsal-<time>…` or `.failed-<time>…` count; a `.partial`
  copy, a link or a file does not.
- `--remove-copies-older-than <days>` (a whole number, 1 or more) removes the copies whose name
  time is older than that, under the update lock, and logs `copies-removed`. It never removes the
  newest pre-update copy, however old (it prints `Kept <path>: …` for it), and it is refused
  (exit 1, nothing removed) while `update-journal.json` exists: an update or first start that is
  pending or halted may need any of them.

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
   folder of them. A release counts when its signature matches the key of the installed version,
   it is newer (minimum previous version and platform as for an update) and every file of its
   package matches the signed hashes, so a damaged or half-copied release is never offered
   (hashing a 7700-file package took about 0.3 to 1 s here). Packages are hashed newest first
   and the check stops at the first that verifies, so old releases kept in the folder add no
   time; `skipped` lists only the candidates that were examined. The result is one JSON line,
   `update_check` or `update_check_failed` (missing folder, a check slower than 10 s, no update
   key).
3. The app shows administrators «Nueva versión de SIPGES», the release notes, «Actualizar» and
   «Ahora no». «Ahora no» hides it until the next start. Nothing is copied or installed before
   «Actualizar».
4. After the click the launcher first checks the release folder again (signature, every hash,
   and that it still holds exactly the version it offered; otherwise it logs
   `update_request_refused`, withdraws the offer and keeps SIPGES running; if SIPGES was stopped
   during that check it logs `update_cancelled` and installs nothing). Then it stops
   SIPGES, runs the same update as `update.mjs` for that exact version (verified again,
   pre-update copy of the state folder, migration, readiness, rollback on failure) and starts the
   resulting version on the same port. The page reloads itself, or says the update failed and
   which version is still running.
5. If the rollback itself does not finish (`ROLLBACK_INCOMPLETE`), no version is started on that
   state folder, neither then nor at the next start: the launcher logs one line
   (`update_failed` or `start_refused`, with an `action`), prints «SIPGES no se inició: …
   Restaure la copia de seguridad … o contacte con soporte.» and exits with code 3.
6. After an update (applied or rolled back) the launcher either runs a version again or ends:
   if the resulting version cannot start (for example its state folder lost a secret), it logs
   `start_failed` and exits with code 1 instead of staying up without a server. A status file
   that cannot be written (`status_write_failed`) never keeps SIPGES from starting or stopping.

Stopping: the first SIGINT or SIGTERM stops the server gracefully (SIGTERM, up to 15 s, then
SIGKILL); a second one kills it at once, logs `stop_forced` and exits with code 1. The server,
like every boot child, watches a pipe from the launcher and ends when the launcher is gone,
however it ended, so no server outlives its launcher. `run-current.mjs` passes both signals on
and kills the launcher 5 s after the second one if it is still there.

The server and the migration boot get the same environment: no inherited `SIPGES_*` variable
reaches them, in any letter case, only the allow-list `LAUNCHER_ENV` in `boot.mjs` (secrets and
folders from the state folder, loopback host and port, plain-HTTP cookies, the version's `web`
and `references` folders, and for the server the update channel). `SIPGES_REFERENCE_DIR` is the
same folder the package's `start.mjs` defaults to. When the server stops, the launcher process
ends at once (the stop grace timer does not hold it).

### The stable entry

The installers (`deploy/desktop/windows/install.ps1 -Release`, `deploy/desktop/linux/install.sh
--managed`, see [../README.md](../README.md)) copy `run-current.mjs` into the install root, outside
`versions/`, and the shortcut starts it: it reads `current.json` and runs that version's
`updater/launcher.mjs --install <root>` with the same options, then ends with the launcher's exit
code. The start scripts beside it (`start.ps1` on Windows, `sipges-desktop.sh` on Linux) pass
`--releases <root>/releases`, write `<root>/launcher.log`, open the browser and stay with the
launcher: exit code 3 shows the halt notice in a message box or a notification.

The launcher and the API share `<root>/update-channel/` (`SIPGES_DESKTOP_UPDATE_DIR`):
`status.json` (written by the launcher) and `request.json` (written by the API after the
click). A request only names a version: the launcher applies the release it verified for that
version and ignores anything else, and drops any request left from an earlier run. Without
`SIPGES_DESKTOP_UPDATE_DIR` (cloud, development clones) the routes do not exist, and only the
packaged web app (marked `<meta name="sipges-desktop">` by the builder) asks for them.

Backups: every update leaves `<state>.pre-update-<time>-<from>-to-<to>` beside the state folder;
copy the state folder yourself before the first update, as in `deploy/desktop/README.md`.
Failure: a failed update rolls back by itself and the previous version starts again; after a
power cut the next start (or `update.mjs --recover`) finishes the rollback. If even that cannot
finish, SIPGES stays stopped (exit code 3) until the state folder is restored from the
pre-update copy.

## Limits

- Tested on Linux with synthetic data and injected migration and readiness. The CLI boot path and
  Windows (junctions, rename retries, process stop) have not been run.
- Reversing to the previous version restores the pre-update copy: records written after the update
  started are not carried back.
- `update.mjs` does not detect a running SIPGES; stop it first. The launcher stops its own
  server before an update. The installers refuse while something answers on port 8000.
- The launcher was run end to end on Linux only; on Windows stopping the server is a hard stop.
- An old install that is a Git clone (no `metadata.json`) cannot be adopted; its state folder is
  carried instead: a managed install on that folder or on a copy of it, and the first start above
  ([../migration/README.md](../migration/README.md), rehearsed on Linux only).
