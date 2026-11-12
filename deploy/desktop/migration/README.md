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

At the end the scratch worktree is removed with `git worktree remove --force` and the signed
release copy is deleted; the state folders, `before.json` and the logs stay under
`.data/migration-rehearsal/<run>` (ignored by Git). The package stays under
`.data/desktop-packages/`; pass it with `--package` to skip the build on a rerun.

## Reading the comparison

From the rehearsal of `e490339c` (2026-11-12, run `20261112T033655Z`), first start:

```text
Sign-in: ok (password and MFA code)
project 1 [008e7c91]
  actores: 2 -> 2, every field identical
  alertas: 1 -> 1, every field identical
  compromisos: 1 -> 1, every field identical
  demandas: 1 -> 1, every field identical
  eventos: 3 -> 3, every field identical
  fuentes: 1 -> 1, every field identical
  links: 4 -> 4, identical
  uploads: 2 -> 2, sha256 7eaf7bd1cee9… identical
  export attachments: 2 -> 2, identical
  export record_links: 4 -> 4, identical
  export record_versions: 12 -> 12, identical
  audit: 16 -> 16, 16 kept unchanged
project 2 [5d82d28a]
  actores: 1 -> 1, every field identical
  demandas: 1 -> 1, every field identical
  eventos: 2 -> 2, every field identical
  links: 1 -> 1, identical
  uploads: 1 -> 1, sha256 92c915f91e39… identical
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
- `project N [hash]`: projects in the order of their identifiers; the hash is keyed with the
  snapshot's salt, so it means nothing outside this comparison.
- One line per module with records: count before and after, then either `every field identical`
  or the problems: `record [hash] missing`, `record [hash] new`, `record [hash] field [hash]
differs`, `missing`, `new`, `record [hash] update time differs`.
- `links`, `uploads` (content SHA-256 of every file, downloaded), `export <table>` (the other
  tables of the project export, `GET /system/export`, as sets of row hashes: attachment rows,
  record links, record history versions, document and alert reviews, preventive actions).
- `audit`: before -> after, entries kept unchanged, `missing`, `changed`, and every entry added
  since the snapshot listed by id, module and action (`added: #23 auth/login`). Added entries
  are listed but are not differences. In the rehearsal none were added: the move writes no
  audit entry.
- `Accounts`: every account's summary (name, role, active, Google link) hashed.
- `Isolation`: for up to 25 records per module and 25 uploads of each project, the same id is
  asked for in every other project. It must answer 404, or that project's own record of the same
  id with its own content.
- `RESULT`: `no difference`, or the number of differences; exit code 0 or 1.

`snapshot.mjs` prints the same counts and short hashes. Its file holds only counts, keyed hashes
and the salt, and is written with mode 600; it is refused if the file exists. Keep it with the
data all the same: with the salt, a guessed value can be confirmed.

Not compared: notifications, automation rules and channels (a channel's
sealed settings can only be read back by sending to its public HTTPS address), sessions and push
subscriptions. Uploads beyond the first 500 of a project are not compared (a warning says so).

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
