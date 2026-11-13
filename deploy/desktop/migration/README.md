# Carry an older install's data into the managed version

Closure-roadmap T33. A clone-based install (`deploy/desktop/windows/install.ps1` or
`deploy/desktop/linux/install.sh` from an older commit) keeps its data in a state folder:
`pglite`, `uploads`, `data-key`, `admin-password` (and `api.log`). The managed version
([../README.md](../README.md#managed-install-the-definitive-version)) opens that folder in place.
This folder holds the proof that it does, and the scripts to check it on the real laptop.

| File                 | What it does                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `snapshot.mjs`       | Signs in through the public HTTP API and writes counts and keyed hashes of every project.              |
| `compare.mjs`        | Takes the same snapshot of a running SIPGES and prints the differences, then probes project isolation. |
| `rehearse.mjs`       | The whole move with synthetic data, from any older commit to this checkout, on Linux.                  |
| `client.mjs`         | Sign-in, TOTP, keyed hashes; shared by the three.                                                      |
| `migration.test.mjs` | Tests of the two scripts against a fake API full of recognisable synthetic values.                     |
| `rehearse.test.mjs`  | Tests that every process the rehearsal starts is stopped and awaited, also on SIGINT and SIGTERM.      |

The scripts need only Node.js 24 or later; nothing to install. They never print or store a record,
a name, a file or a password.

## How the move works

1. The old version is stopped and its state folder copied.
2. The managed install is pointed at the copy: `install.sh --managed <release>` with
   `SIPGES_DESKTOP_STATE=<copy>` on Linux, `install.ps1 -Release <release> -State <copy>` on
   Windows. The original folder is never opened again, so the old version keeps working on it.
3. The first start of the managed version over a folder that already holds a database
   (`updater.mjs` `firstStart`, run by the launcher, or by
   `update.mjs --install <root> --first-start` in a terminal):
   - refuses, before writing anything, when `data-key` or `admin-password` is missing or empty
     (a new key would make the sealed MFA secrets unreadable; the installers refuse the same way);
   - copies the folder beside itself as `<state>.pre-update-<UTC time>-first-start-<version>` and
     never deletes that copy;
   - starts the new version once on a second copy, `<state>.rehearsal-<time>-<version>` (the API
     applies its migrations at boot). If that fails, the state folder was not touched and SIPGES
     does not start (`start_refused` in `launcher.log`, «… Sus datos no se tocaron …»);
   - then on the state folder itself. If that fails, the folder is restored from the dated copy and
     the changed one is kept as `<state>.failed-<time>-<version>`;
   - records `first-start.json` in the install root. Later starts change nothing.
4. `compare.mjs` against the snapshot taken before step 1 must print `RESULT: no difference`.

No database migration was added between the desktop launchers (`6d867050`, the first commit with
`deploy/desktop/windows/install.ps1`) and this checkout, so any clone-based install from that
commit on has the schema of the managed version. The first start still boots on copies first.

## The rehearsal

```sh
node deploy/desktop/migration/rehearse.mjs <source-commit> [--package .data/desktop-packages/sipges-<version>]
```

Run it from the checkout that will be installed, with the commit the laptop runs (closure-roadmap
T27; `e490339c` until it is known). It takes about 2 minutes plus the package build.

1. `git worktree add --detach --no-checkout` of the commit under
   `.data/migration-rehearsal/<run>/old`, then every tracked file except `data/` is checked out:
   the old API can never read a repository dataset. `pnpm install --frozen-lockfile
--prefer-offline` and the web build run there, as the old installer does.
2. The old API starts with the old launcher's environment (`SIPGES_DATA_KEY`,
   `SIPGES_ADMIN_PASSWORD`, `SIPGES_COOKIE_SECURE=0`, `SIPGES_HOST=127.0.0.1`, `SIPGES_PGLITE_DIR`,
   `SIPGES_UPLOAD_DIR`, `SIPGES_WEB_DIR`, output appended to `api.log` in the state folder) on a
   scratch state folder whose `data-key` and `admin-password` are made like `install.ps1` makes
   them, under a scratch `HOME`. The only change: a free port instead of 8000 (8000 and 18080 are
   never used). Synthetic data goes in through the public API: two projects, records in six
   modules (one id, `EV-COMUN-001`, in both projects with different content), one record updated,
   links, three uploads, the administrator with MFA (a TOTP secret the rehearsal keeps) and a
   second account without MFA granted one project. The audit trail fills itself.
3. `snapshot.mjs`, then the old API stops and the state folder is copied.
4. The package is built from this checkout with `deploy/desktop/package/builder.mjs` (or taken
   from `--package`), signed with a throwaway in-memory key and installed with
   `deploy/desktop/linux/install.sh --managed` pointing at the copy.
5. `run-current.mjs` starts it: the first start takes its dated copy (checked equal to the old
   folder), rehearses, migrates; `compare.mjs` must print no difference; the second account signs
   in with its old password; the original folder is byte-identical.
6. Rule d: the installer and the start run again. No second first start, nothing new beside the
   folder, `compare.mjs` again.
7. The backup drill of [../README.md](../README.md#back-up-and-restore) (closure-roadmap T11):
   stop, copy the state folder, check files and bytes, delete it, restore it from the copy,
   start, `compare.mjs`, second account.

Every process the rehearsal starts (the old API, the managed launcher, the snapshot and compare
runs) is tracked until it ends. On any way out (the end, a failed check, a start that never gets
ready, SIGINT or SIGTERM) each one is stopped (SIGTERM, then SIGKILL after 30 s) and awaited
before the clean-up; an interrupted run exits with code 130, and a second signal kills them at
once. The second account's check compares what it opens: the same number of projects (at least
one) before and after the move, with status 200.

At the end the scratch worktree is removed with `git worktree remove --force` and the signed
release copy is deleted; the state folders, `before.json` and the logs stay under
`.data/migration-rehearsal/<run>` (ignored by Git). The package stays under
`.data/desktop-packages/`; pass it with `--package` to skip the build on a rerun.

## Reading the comparison

From the rehearsal of `e490339c` (2026-11-12, run `20261112T033655Z`), first start. That run used
snapshot format 2; since format 3 the upload lines say `content <keyed hash>… identical` instead
of the plain `sha256`, shown below as `<keyed>` (not rerun since):

```text
Sign-in: ok (password and MFA code)
Managed install: version <version>
project 1 [008e7c91]
  actores: 2 -> 2, every field identical
  alertas: 1 -> 1, every field identical
  compromisos: 1 -> 1, every field identical
  demandas: 1 -> 1, every field identical
  eventos: 3 -> 3, every field identical
  fuentes: 1 -> 1, every field identical
  links: 4 -> 4, identical
  uploads: 2 -> 2, content <keyed>… identical
  export attachments: 2 -> 2, identical
  export record_links: 4 -> 4, identical
  export record_versions: 12 -> 12, identical
  audit: 16 -> 16, 16 kept unchanged
project 2 [5d82d28a]
  actores: 1 -> 1, every field identical
  demandas: 1 -> 1, every field identical
  eventos: 2 -> 2, every field identical
  links: 1 -> 1, identical
  uploads: 1 -> 1, content <keyed>… identical
  export attachments: 1 -> 1, identical
  export record_links: 1 -> 1, identical
  export record_versions: 5 -> 5, identical
  audit: 6 -> 6, 6 kept unchanged
project 3 [8a631f4e]
  links: 0 -> 0, identical
  uploads: 0 -> 0, none
  audit: 0 -> 0
Accounts: 2 -> 2, identical
Isolation: 32 probes, no record or upload of one project visible in another
RESULT: no difference
```

- `Sign-in`: the old password and a fresh MFA code still open the account. The MFA secret is
  stored sealed with `data-key`, so this line is also the proof that the old key decrypts under
  the new version. A refused sign-in prints `Sign-in failed (status 401)` and `RESULT: sign-in
failed`.
- `Managed install: version <v>`: which server answers. The old version answers `/health` on the
  same port as the new one, and a SIPGES shortcut reuses whichever server answers, so before
  comparing `compare.mjs` asks for `GET /system/desktop/update`, which only a managed install
  started by the desktop launcher mounts (`apps/api/src/app.ts`, the route in
  `apps/api/src/contexts/system/http/desktop-update-routes.ts`, set up only when
  `SIPGES_DESKTOP_UPDATE_DIR` is set), and prints the installed version it reports. Check it is
  the version just installed. When that route is missing (`Managed install: no (GET
  /system/desktop/update answered 404) …`), answers a redirect (never followed) or anything but
  JSON, or reports no version, nothing is compared: `RESULT: not compared (not the managed
  install)` or `RESULT: not compared (installed version not readable)`; a 403 (the account has no
  project scope or is not an administrator) prints `RESULT: not compared (no project scope for
  this account)`. Exit code 2 in every case, and `--out` is not written. (The sample above predates this check;
  its second line is shown as the comparison prints it now.)
- No request of `compare.mjs` or `snapshot.mjs` follows a redirect (the real API answers none of
  them with one: `POST /login` answers 200 or an error, and only `/select-project` and the Google
  sign-in, which these scripts never call, redirect). A redirect on any other request, sign-in
  included, stops the run with
  `RESULT: not compared (redirect: GET /api/eventos answered 302, not followed)`, the route
  named without its query or ids. A server that cannot be reached or drops the connection prints
  `RESULT: not compared (the server could not be reached or the connection dropped: fetch failed, ECONNREFUSED)`
  (the last part is the socket error), and any other error after the options were read
  `RESULT: not compared (error: …)` (a 200 answer that is not JSON is named by its route, like a
  redirect, and never quoted:
  `error: GET /api/eventos answered 200 with a body that is not valid JSON`). Each also prints
  `Error: …` and exits with code 2. When the run stops during the
  isolation probes, the per-module `identical` lines and the `--out` file may already exist: they
  cover only part of the check, and only the final `RESULT:` line and the exit code are the
  verdict. A server that stops answering without closing the connection can keep `compare.mjs`
  silent for up to about 5 minutes before it prints `RESULT: not compared (…)` and exits with 2.
- `project N [hash]`: projects in the order of their identifiers; the hash is keyed with the
  snapshot's salt, so it means nothing outside this comparison.
- One line per module with records: count before and after, then either `every field identical`
  (each value is hashed with its JSON type, so the text `"12"` and the number `12` differ)
  or the problems: `record [hash] missing`, `record [hash] new`, `record [hash] field [hash]
differs`, `missing`, `new`, `record [hash] update time differs`.
- Every module list is read page after page until an empty page (a version that answers fewer
  rows than asked is still read to the end), and the ids read are checked against the records of
  the project export. `records: not fully checked (…)` names why a list could not be proved
  complete: it repeated rows (its offset is not honoured), or some records of the export were
  never listed (`N records in the project export not read through the lists`: a module these
  scripts do not know, or a list that stopped). The comparison then fails.
- `links`, `uploads` (every file downloaded by its id and its content hashed with the snapshot's
  key, never a plain SHA-256 that would confirm a known document; the upload list shows at most
  500, and the export's attachment rows name the rest), `export <table>` (the other
  tables of the project export, `GET /system/export`, as sets of row hashes: attachment rows,
  record links, record history versions, document and alert reviews, preventive actions).
- `audit`: every entry of the trail with its whole content (time, module, record, action,
  detail; from the project export). Before -> after, entries kept unchanged, `missing`,
  `changed`, and every entry added since the snapshot listed by id, module and action
  (`added: #23 auth/login`). Added entries are listed but are not differences. In the rehearsal
  none were added: the move writes no audit entry.
- `Accounts`: every account's summary (name, role, active, Google link) hashed.
- `Isolation`: for up to 25 records per module and 25 uploads of each project, the same id is
  asked for in every other project. It must answer 404, or that project's own record of the same
  id with its own content.
- `uploads: not fully checked` or `audit: not fully checked`: the project export could not be
  read and there were more uploads than the list shows (500) or more audit entries than one page
  (500). What was read is still compared, but the comparison fails.
- `export: not checked (…)` (the project export is not readable on either side) and
  `Accounts: not checked (…)` (not readable on either side): nothing could be compared for that
  part; each counts as a part not fully checked and fails the comparison. Nothing is skipped
  without a line.
- `RESULT`: `no difference`, the number of differences, or `not fully checked (N parts, listed
above)`; exit code 0 only for `no difference`, otherwise 1 (also `sign-in failed`).
  `not compared (…)` with exit code 2: the server is not the managed install, a redirect, the
  server not reachable or the connection dropped, or another error (above). An invalid option or
  `--before` file prints only `Error: …` and exits with code 1, before signing in.
- The password prompt (`Contraseña:`) does not show what is typed: the terminal is put in raw
  mode with Node's own TTY support (Windows console and Linux alike) and restored afterwards;
  Ctrl+C cancels. The MFA code is shown as typed.

`snapshot.mjs` prints the same counts and short hashes. Its file holds only counts, keyed hashes
and the salt, and is written with mode 600; it is refused if the file exists. It is written only
once everything was read: a redirect
(`Error: GET /api/eventos answered 302, a redirect (not followed)`), a dropped connection or any
other error exits with code 1 and writes no file. Keep it with the
data all the same: with the salt, a guessed value can be confirmed.

Not compared (checked against `apps/api/src/contexts/tenancy/infrastructure/sql-tenant-data-reader.ts`,
the records routes and the migrations):

- of each record, only its fields (the stored `payload`) and its update time: not its
  classification `marking` nor its `created_at` (the export's `module_records` rows are used to
  prove the lists complete, not hashed);
- tables outside the project export: `irsa_configs`, `irsa_snapshots`, `media_feeds`,
  `proposal_decisions`, `link_evidence_history`, `grants`, `api_keys`, `integration_channels`
  (automation channels: their sealed settings can only be read back by sending to their public
  HTTPS address), `tenants` (the project labels), `record_embeddings`, `ingest_receipts`,
  `notification_reads`, `automation_cursors`, `digital_signal_dedup_locks`, `sessions`,
  `login_failures`, `push_subscriptions` and `push_deliveries`;
- of the accounts, only name, role, active flag, creation time and Google link: not the password
  hashes nor the MFA secrets (the administrator's password and MFA are proved by the sign-in;
  every other account's are not);
- projects the signed-in administrator has no grant for (only the projects
  `/system/auth/scopes` lists are read).

Notifications, automation rules and runs, record versions and the other export tables are
compared as row hashes. A snapshot from an earlier `snapshot.mjs` is refused by `compare.mjs` before it
signs in: format version 1 hashed `"12"` and `12` alike and read only the newest 500 uploads and
audit details; version 2 stored each upload's plain SHA-256 and could stop a record list early.
Take it again, with the scripts that will run the comparison, before the move.

## On the visit (Windows)

PowerShell, from the definitive checkout, with Windows' own paths. The closure-roadmap T34
runbook decides the order; these are the commands.

```powershell
# 1. Old version running: the snapshot. Type the admin password and the current MFA code.
node deploy\desktop\migration\snapshot.mjs --url http://127.0.0.1:8000 --out "$env:USERPROFILE\Desktop\sipges-antes.json"
# 2. Close SIPGES, end every node process (Task Manager), then copy the folder.
Copy-Item -Recurse "$env:LOCALAPPDATA\SIPGES" "$env:LOCALAPPDATA\SIPGES-datos"
# 3. Install the signed release on the copy.
powershell -ExecutionPolicy Bypass -File deploy\desktop\windows\install.ps1 -Release <release folder> -State "$env:LOCALAPPDATA\SIPGES-datos"
# 4. The first start in this terminal (no 90-second limit), then open SIPGES from the shortcut.
node "$env:LOCALAPPDATA\SIPGES-app\versions\<version>\updater\update.mjs" --install "$env:LOCALAPPDATA\SIPGES-app" --first-start
# 5. Compare. Wait for a new MFA code: the server refuses a code already used.
node deploy\desktop\migration\compare.mjs --before "$env:USERPROFILE\Desktop\sipges-antes.json" --url http://127.0.0.1:8000
```

`--password-file "$env:LOCALAPPDATA\SIPGES\admin-password"` replaces the password prompt only if
the administrator never changed the password. Any difference: close SIPGES and keep using the old
version; `%LOCALAPPDATA%\SIPGES` was not touched. The managed installer moved the shortcuts to
the managed install, so open the old version with
`powershell -ExecutionPolicy Bypass -File <old clone>\deploy\desktop\windows\start.ps1` until
the old installer is run again.

## Fallback if the in-place move fails

Nothing new was built: the in-place move works from `e490339c`. What exists:

| Tool                                       | What it carries                                                                                   | Gap                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `GET /system/export` (admin, one project)  | Records, audit, attachment metadata, document reviews, alert reviews, preventive actions, as JSON | No import counterpart; no files, accounts, MFA, grants or links. |
| `POST /system/import/:module`              | Records of importable modules, as rows                                                            | Records only; new ids for the audit; no links, files, history.   |
| `POST /system/uploads`                     | One file linked to a record                                                                       | One at a time, new attachment ids.                               |
| `pnpm --filter @sipges/api migrate:legacy` | The Python prototype's SQLite into PostgreSQL                                                     | Not for a PGlite state folder.                                   |
| `deploy/local/ops/backup.sh`, `restore.sh` | The Docker PostgreSQL stack                                                                       | Not for PGlite.                                                  |

If the first start refuses on the laptop: keep the old version on the untouched
`%LOCALAPPDATA%\SIPGES`, keep `launcher.log` and `update-boot.log` from
`%LOCALAPPDATA%\SIPGES-app`, and rerun this rehearsal from the laptop's commit to reproduce it.
An extract-and-load tool would export each project with `/system/export`, recreate projects and
accounts, import records with `/system/import/:module`, re-upload files and recreate links; it
would lose the audit trail, record history and MFA enrolments. It is not built.

## Limits

- Run on Linux only. Windows (`install.ps1 -Release -State`, `Copy-Item`, the first start on NTFS,
  PowerShell 5.1 with these scripts) has not been run.
- The rehearsal source was `e490339c`, the parent of the launcher commit, because the laptop's
  commit is not known yet (closure-roadmap T27). Rerun with that commit.
- A Linux clone install keeps its browser profile in the state folder (`chrome/`, with links and
  sockets); the first start refuses a folder holding links, so move `chrome/` out of the copy
  first. The Windows clone install keeps no browser profile there.
- No migration ran in the rehearsal (none exists between the two versions); the first start's
  rehearsal-then-migrate path was proved with injected failing migrations in
  `deploy/desktop/updater/first-start.test.mjs`.
