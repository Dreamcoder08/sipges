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
| `tables.mjs`         | Offline, SIPGES stopped: the database before and after the move, table by table, every column.         |
| `client.mjs`         | Sign-in, TOTP, keyed hashes; shared by the three.                                                      |
| `migration.test.mjs` | Tests of the two scripts against a fake API full of recognisable synthetic values.                     |
| `rehearse.test.mjs`  | Tests that every process the rehearsal starts is stopped and awaited, also on SIGINT and SIGTERM.      |
| `tables.test.mjs`    | Tests of `tables.mjs` on synthetic PGlite folders: comparisons, refusals, no value ever printed.       |

The scripts need only Node.js 24 or later; nothing to install (`tables.mjs` takes PGlite from the
managed install, `--app`, or from this checkout's `pnpm install`). They never print or store a
record, a name, a file or a password.

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
5. Recommended: SIPGES stopped, right after the first start and before the new version is used,
   `tables.mjs` compares the dated copy of step 3 with the migrated folder, table by table ([below](#table-by-table-offline)).

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
8. SIPGES stopped, `tables.mjs --before <the pre-update copy> --after <moved folder>
   --app <install root>` must print `RESULT: no difference`; its scratch folder is empty
   afterwards and the pre-update copy unchanged. This is the proof that the rules of `tables.mjs`
   match the real migrations. Run of 2026-11-14 from `e490339c`: the whole rehearsal 111 s
   (package build included), `tables.mjs` 3 s, 34 tables and their structure, 13 sequences, no
   difference. That run seeds no IRSA, media feed,
   channel, API key, automation, push or proposal rows: those rules are proved on empty tables.

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
  tables of the project export, `GET /system/export`, as sets of row hashes: attachments,
  record links, record versions, document reviews, alert reviews, preventive actions and their
  log, automation rules and runs, notifications, source import settings and project settings;
  `apps/api/src/contexts/tenancy/infrastructure/sql-tenant-data-reader.ts`).
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

Not compared by `compare.mjs` (checked against `apps/api/src/contexts/tenancy/infrastructure/sql-tenant-data-reader.ts`,
the records routes and the migrations; `tables.mjs` covers the database part of this list,
[below](#table-by-table-offline)):

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

Notifications, automation rules and runs, record versions, source import and project settings
and the other export tables are compared as row hashes, for the projects the administrator can
open. A snapshot from an earlier `snapshot.mjs` is refused by `compare.mjs` before it
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
# 6. Recommended: close SIPGES completely, then table by table (the copy named by step 4).
node deploy\desktop\migration\tables.mjs --before "$env:LOCALAPPDATA\SIPGES-datos.pre-update-<time>-first-start-<version>" --after "$env:LOCALAPPDATA\SIPGES-datos" --app "$env:LOCALAPPDATA\SIPGES-app"
```

`--password-file "$env:LOCALAPPDATA\SIPGES\admin-password"` replaces the password prompt only if
the administrator never changed the password. Any difference: close SIPGES and keep using the old
version; `%LOCALAPPDATA%\SIPGES` was not touched. The managed installer moved the shortcuts to
the managed install, so open the old version with
`powershell -ExecutionPolicy Bypass -File <old clone>\deploy\desktop\windows\start.ps1` until
the old installer is run again.

## Table by table, offline

```sh
node deploy/desktop/migration/tables.mjs --before <state>.pre-update-<time>-first-start-<version> \
  --after <state> [--app <install root>] [--scratch <folder>] [--port 8000]
```

SIPGES stopped, right after the first start and before anyone uses the new version. It compares
the database of the launcher's dated copy (the folder as it was before the migration) with the
migrated state folder. Nothing to sign in to.

What is compared:

- the row values of every column of every table of the catalog: password hashes, sealed MFA
  secrets, sealed channel settings, API key hashes, other users' grants and projects the
  administrator cannot open included (values read as text, by primary key or as a multiset);
- the structure of every table: each column's data type and nullability, its constraints
  (primary, unique, foreign keys, checks) and unique indexes, whether row-level security is
  enabled and forced, its policy names and its trigger names with their enabled state;
- every sequence's last value, which may only stay or grow.

Not compared: that other accounts can still sign in (their hashes are compared, their
passwords are not tried), that sealed values still decrypt with `data-key` (the
administrator's MFA is proved by `compare.mjs`'s sign-in), the bytes of the uploaded files
(`uploads/`, compared by `compare.mjs` for the projects the administrator can open), behaviour,
the columns a rule leaves out, the rows a rule allows to be added, and the ephemeral tables. Of
the structure, these are not compared either: column defaults, functions (a trigger's function
body included), the expression of a policy and the definition of a trigger (only their names,
and whether a trigger is enabled), indexes that are not unique, owners and privileges (grants),
a sequence's settings other than its last value, views.

Rows a rule allows to be added (a sign-in's audit entry, a session) pass; any other legitimate
write since the first start (an edited record, a feed import, a new grant) shows as a
difference: run it right after the first start, before the new version is used. How long it takes depends on the size
of the database; the scratch drive needs room for a copy of each database folder.

How the inputs are protected. PGlite has no read-only mode and may write to a folder it opens,
so neither input is ever opened. Only each input's database folder, `pglite/`, is copied, to a
new `sipges-tables-*` folder under `--scratch` (default the temp folder): never `data-key`,
`admin-password`, `uploads/` or anything else of the state folder. The copy is checked equal to
its source, only the copies are opened, and they are removed at the end, also after an error,
and on Ctrl+C, SIGTERM or a closed terminal (`RESULT: not compared (interrupted)`, exit 2). A
signal only asks the run to stop: the run removes its copy itself once the step in flight has
ended (removing it from the signal handler raced the copy still being written and left part of
a database behind), so the RESULT line can take as long as copying one database; wait for it.
It then checks the folder is gone, and names it if not (`the scratch copy <folder> could not be
removed …: delete that folder`). A signal in the first instant, before anything is copied, may
end the process with no RESULT line. Each `pglite/` folder,
the only part read, is hashed (names, sizes, bytes) before and after; if one changed: `RESULT:
not compared (an input folder changed during the run)`. The rest of the state folder is not
read, so it is not proved unchanged either (only listed, to refuse links). If the process is
killed outright (Task Manager, `kill -9`), its copy stays: delete only the `sipges-tables-*`
folder it names under `--scratch` (by default the temp folder: `%TEMP%\sipges-tables-*` on
Windows), nothing else there.

It refuses, exit code 2 and nothing copied: an input that is a link or junction or holds one
(or any special file), an input without `pglite/PG_VERSION`, the same folder twice or one inside
the other, `--scratch` inside an input or without room for both database folders, anything
answering on `--port` (SIPGES open), a `pglite/postmaster.pid` written in the last 2 minutes
(PGlite writes it on open and removes it on close; a killed SIPGES leaves an old one, which does
not count), and a fresh `update.lock` (an update or first start running) in `--app` or in an
install root beside an input that records it as its state folder. There is no launcher heartbeat
to read: the port and these two files are the checks. PGlite is the installed version's
(`--app`, its `current.json`), or this checkout's when `--app` is not given; the visit's scripts
come from a zip without `node_modules`, so `--app` is needed there.

Output, one line per table, then the sequences and the verdict:

```text
Migrations applied between the two: none
Structure: compared (column types and nullability, keys and constraints, row-level security, policies, triggers, sequences)
audit: 22 -> 24, identical (0032 not run between the two), 2 rows added
automation_cursors: 2 -> 2, identical except last_tick_token, …, last_tick_error, last_audit_id not lower
module_records: 13 -> 13, identical
sessions: ephemeral, 5 -> 10
users: 2 -> 2, identical except totp_last_step (0032 not run between the two)
Sequences: 21 -> 21, none decreased
RESULT: no difference
```

A difference reads `users: 2 -> 2, row [3fa1c09e] differs in password_hash`, `api_keys: 2 -> 1,
row [5b0e7d21] missing`, `row [...] new`, `row [...] last_audit_id decreased`, `column <name>
missing after`, for a table without primary key `N rows missing or changed`, and for the
structure `users: structure differs: column totp_enabled type boolean -> text`, `… constraint
<name> missing after`, `… row-level security enabled -> disabled`, `… policy <name> missing
after`, `… trigger <name> missing after` (or `enabled O -> D`), `sequence <name>: last value
decreased`. Each counts as a difference. No value is ever printed: a row is named by an 8-hex
fingerprint of its primary key, an HMAC-SHA-256 with a random key made in memory for each run
and never written, so two runs cannot be matched and a fingerprint cannot confirm a guess.
Errors print only `the database could not be read (SQLSTATE <code>)`, `file system error
<code>` or `unexpected <error class>` (for instance `unexpected RuntimeError` for a database
PGlite cannot open), never PGlite's message or SQL. `RESULT: no difference` exit 0; `RESULT: N differences`
or `RESULT: not fully compared (…)` exit 1; `RESULT: not compared (…)` exit 2.

The rules are one data structure at the top of `tables.mjs`, one per table with its reason; a
test applies the real migrations and fails if a table has no rule or a rule no table. A table
with no rule makes the run `not fully compared (table <name> has no rule)`, and so does a ruled
table found in neither database (`… is in neither database`: two empty databases never pass); a
table missing after the move is a difference. Tables and columns come from each database's
catalog. A name read from a database (a table, column, trigger, sequence or migration version
called `constructor`, `toString` or `__proto__`) is only ever looked up among the declared
entries, never among what a JavaScript object inherits: a migration version with no declared
expectation always leaves the run `not fully compared`.

- `identical` (same rows by primary key, or as a multiset without one; every common column):
  `module_records`, `tenants`, `irsa_configs`, `irsa_snapshots`.
- `expected-change`, migration `0032_rename_admin_username.sql`: when 0032 ran between the two,
  every row before, with the exact value `mascli-admin` of the migration's reviewed column read
  as `sipges-admin` (`audit.detail`: only its two templates; free text naming the old login
  stays as written), must be in the migrated database with every other column identical; when
  it did not run, `identical`. `users` (hashes and sealed MFA secrets byte for byte;
  `totp_last_step` left out, it moves at each MFA sign-in), `api_keys` (`last_used_at` left out),
  `grants`, `attachments`, `automation_rules`, `digital_alert_reviews`, `document_review`,
  `integration_channels`, `link_evidence_history`, `preventive_actions`, `preventive_action_log`,
  `project_settings`, `proposal_decisions`, `record_links`, `record_versions`, `media_feeds` and
  `source_import_settings` (poll status columns left out: the automation tick polls them); with
  rows that may be added: `audit` (sign-ins and work), `notification_reads`,
  `push_subscriptions`, `push_deliveries` (delivery status left out).
- `superset`, rows may be added and existing ones must not change: `schema_migrations` (the
  versions this start applied), `notifications`, `ingest_receipts`, `digital_signal_dedup_locks`
  (the app never deletes a dedup key), `automation_runs` (status, attempts and times of a
  retried run left out), `record_embeddings` (a derived index: only that no row vanishes),
  `automation_cursors` (the tick's durable audit position: no row may vanish and
  `last_audit_id` may not go back, which would replay or skip automations; the last tick's
  status columns left out).
- `ephemeral`, counts only: `sessions`, `login_failures`.

Any other migration applied between the two (read from `schema_migrations`) makes the run `not
fully compared (migration <n> ran between the two and declares no expected change here)`, and
then the structure is not compared (`Structure: not compared (…)`): such a migration may change
it. That includes 0030 and 0031, which rewrite tenant ids in every table: every clone install
from the first installer (`6d867050`) on already has all 32 migrations, so on the laptop none
runs. With only 0032 between the two, the structure is compared (0032 restores what it lifts).

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
  PowerShell 5.1 with these scripts) has not been run. `tables.mjs` has not run on Windows
  (copying NTFS folders, the installed PGlite under `SIPGES-app`, junction refusals) until the
  Windows drill runs it.
- The rehearsal source was `e490339c`, the parent of the launcher commit, because the laptop's
  commit is not known yet (closure-roadmap T27). Rerun with that commit.
- A Linux clone install keeps its browser profile in the state folder (`chrome/`, with links and
  sockets); the first start refuses a folder holding links, so move `chrome/` out of the copy
  first. The Windows clone install keeps no browser profile there.
- No migration ran in the rehearsal (none exists between the two versions); the first start's
  rehearsal-then-migrate path was proved with injected failing migrations in
  `deploy/desktop/updater/first-start.test.mjs`.
