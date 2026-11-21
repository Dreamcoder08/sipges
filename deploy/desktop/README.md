# SIPGES on your own computer (Windows and Linux)

Español: [README.es.md](README.es.md)

**Run SIPGES from your own fork, with your data on your own disk, opened like any desktop app.**
No paid account is needed. Nothing leaves the computer.

## How the sovereignty works

| What | Where it lives | Who controls it |
| --- | --- | --- |
| The code | Your fork on your own GitHub account, cloned to this computer | You |
| The data (database, uploaded files) | The state folder, in your user profile | You |
| The secrets (data key, admin password) | Two files in the state folder, readable only by your user | You |
| The server | A process on this computer, listening on `127.0.0.1:8000` only | You |

| System | State folder |
| --- | --- |
| Windows | `%LOCALAPPDATA%\SIPGES` |
| Linux | `~/.local/share/sipges-local` |

Cloudflare and Neon are only needed to **publish** SIPGES online; this setup does not use them.
Local AI is optional: see [Optional: local AI](#optional-local-ai).

## Install (once)

You need [Git](https://git-scm.com/) and Node.js 24 or later. On Linux also `curl` and `openssl`
(preinstalled on most distributions). The installer adds pnpm 12.11.2 through npm. If that fails, run `npm install -g pnpm@12.11.2` in a new terminal and try again.

| Step | Windows | Linux |
| --- | --- | --- |
| 1. Fork the repository on GitHub, then clone your fork | `git clone <your fork URL>` | `git clone <your fork URL>` |
| 2. Install Node.js 24+, then **open a new terminal** so it is found | `winget install OpenJS.NodeJS.LTS` | Your package manager, or [nodejs.org](https://nodejs.org/) |
| 3. Run the installer from the clone | `powershell -ExecutionPolicy Bypass -File deploy\desktop\windows\install.ps1` | `deploy/desktop/linux/install.sh` |

The installer installs the dependencies, builds the web app, creates the state folder and adds
**SIPGES** to the Start menu and Desktop (Windows) or to the application launcher (Linux).
It prints where the admin password is.

## Daily use

Open **SIPGES** from the menu. The first start takes up to a minute; the next ones are quick.

1. Sign in as `admin` with the password in `admin-password` (state folder).
2. SIPGES asks you to set up an authenticator app on the first sign-in. MFA stays on.

Closing the window leaves the server running, so the next open is instant. Signing out of the
computer or restarting stops it.

If the window does not open, read `api.log` in the state folder. New runs are appended to it.

## Update

```sh
git pull
```

Then run the installer again. It keeps your data, key and password. This is for the clone
install; a [managed install](#managed-install-the-definitive-version) updates from the notice
inside SIPGES.

## Managed install (the definitive version)

Instead of running from the clone, the computer can run a **signed release**: a package built by
`deploy/desktop/package/builder.mjs` and signed with `deploy/desktop/updater/release.mjs`
([updater/README.md](updater/README.md)). The installed app no longer depends on the clone, and a
newer release is offered inside SIPGES («Nueva versión de SIPGES», «Actualizar»).

| Step | Windows | Linux |
| --- | --- | --- |
| 1. Close SIPGES; the installer refuses while SIPGES answers on port 8000 | Restart, or end `node` in Task Manager | `pkill -f apps/api/src/main.ts` |
| 2. Back up the state folder | [Back up and restore](#back-up-and-restore) | [Back up and restore](#back-up-and-restore) |
| 3. Install the release | `powershell -ExecutionPolicy Bypass -File deploy\desktop\windows\install.ps1 -Release <release folder>` | `deploy/desktop/linux/install.sh --managed <release folder>` |

- The install root is `%LOCALAPPDATA%\SIPGES-app` (Windows) or `~/.local/share/sipges-app`
  (Linux): `versions/`, `current.json`, `install.json`, `releases/`, `launcher.log`,
  `run-current.mjs` and the start script. The shortcuts (Windows) and the launcher entry (Linux)
  point at the start script in that root, so they keep working after every update.
- The state folder stays where it is. Nothing in it is overwritten or deleted; only a missing data
  key or admin password is created, and never beside an existing database: the installer stops
  if the database is there but its `data-key` or `admin-password` is not (restore it from your
  backup).
- The first start over an existing database copies the folder beside itself
  (`<state>.pre-update-<time>-first-start-<version>`, never deleted), runs the new version on a
  second copy first and only then on the folder; if that fails, SIPGES does not start and the
  folder is as it was. To run it in a terminal, without the shortcut's wait (5 minutes on Windows, 90 seconds on Linux):
  `node <root>/versions/<version>/updater/update.mjs --install <root> --first-start`. Step 2
  still comes first. Closing SIPGES during the first start stops its test runs too and puts the
  folder back from that copy; the next start does it again. If the computer was switched off in
  the middle, the next start puts the folder back the same way before trying again.
- To install on a copy of the state folder and leave the original to the clone install (the data
  move, [migration/README.md](migration/README.md)): `-State <copy>` on Windows,
  `SIPGES_DESKTOP_STATE=<copy>` on Linux. Give the real folder of the copy, never a link to it:
  a link or junction would be recorded as its target, and the first start would migrate the
  original in place. The installer stops with exit code 1 before writing anything when the folder
  given is a link or junction, or, on a first install, leads to the original
  (`%LOCALAPPDATA%\SIPGES`, or `~/.local/share/sipges-local` on Linux). `update.mjs --install`
  refuses a link too on a first install; with `--adopt` it still follows one and records the
  folder it leads to, so give `--adopt` the real folder as well.
- The key that signed the release becomes the only key later updates are accepted with. The
  installer prints its SHA-256 fingerprint: compare it with the one noted when the key was made.
- To offer a newer release, copy its folder into `releases` in the install root. At the next
  start an administrator sees the notice; nothing is installed before «Actualizar».
- Running the installer again keeps the installed version and only refreshes the shortcuts. It
  keeps the state folder recorded in `install.json` too, and stops without changing anything when
  another one is given (`-State` or `SIPGES_DESKTOP_STATE`). While an update is pending or halted
  (`update-journal.json` in the install root) the installer, in either mode, stops with exit code 1
  and «Hay una actualización de SIPGES pendiente o detenida …» before creating anything: a state
  folder created then, even empty, could be taken for the restored one.
- The log is `launcher.log` in the install root, not in the state folder: an update copies that
  folder and may move it while SIPGES runs.
- Copies beside the state folder (`.pre-update-…`, `.rehearsal-…`, `.failed-…`) are never deleted
  by SIPGES. Each start writes how many there are and their total size in `launcher.log`
  (`"stateCopies":{"count":…,"bytes":…}` on the `started` line). To list them on a Go install
  (its version holds `go/sipges-desktop`; `.exe` on Windows):
  `<root>/versions/<version>/go/sipges-desktop --install <root> --copies`. To remove those older
  than 30 days (any number of whole days), with SIPGES closed:
  `<root>/versions/<version>/go/sipges-desktop --install <root> --remove-copies-older-than 30`.
  On an install still on TypeScript the same options go to
  `node <root>/versions/<version>/updater/update.mjs`. It never removes the newest pre-update copy
  (it says `Kept …`), and it refuses while an update is halfway (below). The Go command also
  refuses while SIPGES runs on the install and first stops a PostgreSQL a killed launcher left
  running, as the start does. Back up first: removed copies are gone.
- Closing SIPGES (Ctrl+C or SIGTERM) waits up to 15 s for the server to stop cleanly; a second
  Ctrl+C or SIGTERM kills it at once (exit code 1, `stop_forced` in `launcher.log`).

### If an update stops halfway

If an update fails and even its rollback cannot finish, SIPGES does not start on that data. The
person sees «SIPGES no se inició: … Restaure la copia de seguridad <copy> o contacte con soporte.»
in a message box (Windows) or a notification and the terminal (Linux). `<version>` below is the one
in `current.json` of the install root. `<cli>` is
`<root>/versions/<version>/go/sipges-desktop` (`.exe` on Windows) on a Go install, whose version
holds `go/`; on an install still on TypeScript it is
`node <root>/versions/<version>/updater/update.mjs`. Both take the same options, print the same
lines and end with the same exit codes; the Go one refuses while SIPGES runs on the install and
first stops a PostgreSQL a killed launcher left running (`--pg-bin <dir>` names PostgreSQL 18 when
the version bundles none).

1. Delete nothing.
2. Retry the rollback (it finishes once the cause, such as a full disk, is fixed):
   `<cli> --install <root> --recover`.
   If it prints `Recovered`, open SIPGES. If it says the state folder «was created again while its
   restore was pending», something (an installer run, a person) made a new folder at that path
   after the update moved the old one aside: move that new folder aside too (do not delete it),
   then run `--recover` again; it puts the restored copy it names back in place. If it says the
   folder «cannot be proven restored» or that the pre-update copy is missing, go to step 3.
3. Otherwise restore the state folder yourself: rename the damaged folder aside (for example add
   `.damaged`), then copy the copy named in the message, or your own backup, to the original path.
4. Run `<cli> --install <root> --recover --accept-restored-state`.
   It refuses while the state folder is missing or empty; otherwise the version from before the
   update becomes current again and nothing in or beside the state folder is touched.
5. Open SIPGES.

### Windows drill (automatic)

`deploy/desktop/windows/drill.mjs` runs the visit's data move, an update and a halt on a real
Windows machine with synthetic data only: the clone install of an old commit (default `e490339c`,
with the clone-mode installer of `6d867050`; `--old-commit` takes the laptop's commit), seeded
through the public API, `snapshot.mjs`; the package built and signed with a throwaway key;
`install.ps1 -Release … -State <copy>`, `update.mjs --first-start`, the installed `start.ps1`,
`compare.mjs` (`RESULT: no difference`) and the original folder unchanged; N+1 signed into
`<root>\releases`, offered, asked for through `POST /system/desktop/update`, compared again; and a
halt (exit code 3 and the notice). GitHub Actions runs it on `windows-latest`
(`.github/workflows/windows-desktop.yml`) once per candidate old commit (every clone-mode installer
from `6d867050` to `main`; a manual run with `old_commit` drills just that one) and uploads the logs.
The same workflow builds the visit kit with `deploy/desktop/windows/visit-kit.mjs` into a temporary
folder and installs from it. By hand, on another Windows
computer or account, never the laptop, with port 8000 free:

```powershell
pnpm install --frozen-lockfile
node deploy\desktop\windows\drill.mjs [--old-commit <commit>] [--work <new folder>] [--logs <folder>]
```

It ends with `DRILL PASSED` (exit 0) or `DRILL FAILED: …` (exit 1). While it runs it rewrites the
SIPGES shortcuts of that account and puts them back at the end, and the old `start.ps1` opens Edge
once. The scripts come from `git archive HEAD`, as on the visit USB, so uncommitted changes are not
drilled. `SIPGES_DESKTOP_NO_UI=1` makes the installed `start.ps1` print its messages instead of
showing a message box and skip Edge; the drill sets it. `install.ps1` and `start-managed.ps1`
write UTF-8 while they run, so a caller reading their output through a pipe gets the accents as
typed; the drill checks `SIPGES está instalado`.

The visit USB itself is one command, on Windows, from a clean checkout of the definitive commit:
`node deploy\desktop\windows\visit-kit.mjs --version <semver> --key K:\<key>.pem --out F:\` builds,
creates or reuses the signing key, signs, and writes `F:\SIPGES-visita` (the signed release,
`sipges-scripts.zip`, `fingerprint.txt`, `LEEME.txt`). The runbook
([desktop-visit.es.md](../../docs/deployment/desktop-visit.es.md)) says when: at the visit it runs
on the laptop itself, from a second clone (`C:\SIPGES-kit`), with `--out F:\` or, with a single
USB, `--out C:\SIPGES-kit-salida`. Before building it refuses, writing nothing, when Node is older
than 24, pnpm 12 is missing, the checkout, key or kit falls inside the old clone or
`%LOCALAPPDATA%\SIPGES*`, SIPGES answers on port 8000, or free space is short. The workflow's
laptop-kit job rehearses it (`deploy/desktop/windows/laptop-kit.mjs`): a clone install of an old
commit, a second clone with its own `pnpm install`, the refusals, the kit, the install from the kit
and the comparison; the old clone stays byte-identical, and time and space are measured.

### Go mode

The desktop is moving to the Go API on a bundled PostgreSQL 18 (ADR 0036, go-rust-stack T72).
A version built with `--go` installs and starts without Node; an install whose data are still only
in PGlite keeps the TypeScript API until its data are moved (the laptop visit,
[docs/deployment/desktop-visit.es.md](../../docs/deployment/desktop-visit.es.md) section 6).

- **Bundle.** `node deploy/desktop/package/builder.mjs … --go` adds `go/` (`sipges-desktop`, the Go
  API, the SQL migrations and `pglite/`, the pinned PGlite 0.5.15 files of the data move) and, on Windows x64, `postgresql/` (`bin`, `lib`, `share` and the
  licences). Without `--go` the package is exactly what it was.
- **Pinned and verified.** [`postgresql/pg18.json`](postgresql/pg18.json) pins the EDB Windows x64
  binaries zip by exact URL, size and SHA-256: PostgreSQL 18.6-2, published 2026-10-05, pinned
  2026-11-18 (at least two weeks old, as pnpm's `minimumReleaseAge`; 18.6 is also the version PGlite
  0.5.15 embeds). [`postgresql/bundle.mjs`](postgresql/bundle.mjs) downloads it once into
  `.data/postgresql`, hashes it, and deletes a download that does not match; a build without network
  and without a verified copy stops with a message saying so, never with an unverified zip. The
  binaries are never committed. To move to another minor, check the
  [EDB page](https://www.enterprisedb.com/download-postgresql-binaries), take a build at least two
  weeks old, and update the version, URL, size, SHA-256 and dates together.
- **Trimmed.** Of the 914 MB unpacked zip only `bin`, `lib`, `share` and the two command-line
  licences stay (about 132 MB): pgAdmin 4, StackBuilder, `doc`, `include` and `symbols` go, and so do
  `stackbuilder.exe`, the wxWidgets DLLs and the `*.lib` import libraries inside `bin`.
- **Installers.** `install.ps1 -Release` and `install.sh --managed` install a release built with
  `--go` with the kit's trusted `deploy/desktop/bin/sipges-desktop` (built from the trusted
  checkout; `windows/drill.mjs` `packScripts` puts it in the kit's zip): `--install <root> --release
  <dir> --state <dir> --trust-release-key`. The release's own `go/sipges-desktop` never runs to
  install it (it could verify itself); without the trusted one the installer refuses a Go release.
  The trusted binary verifies the signature, installs, records the real path of the state
  folder in `install.json` and prints the key's fingerprint, exactly as `update.mjs` does: no Node
  is needed. A release without `go/` is still installed by `update.mjs` (Node 24).
- **Launchers.** The shortcut (`start.ps1`, the install's copy of `windows/start-managed.ps1`;
  `sipges-desktop.sh`, Linux, `linux/sipges-managed.sh`) starts the current version's Go launcher,
  `go/sipges-desktop --install <root> --releases <root>/releases` with its `postgresql/bin`
  (Linux: that folder or `SIPGES_PG_BIN`), when the version has them and the state folder
  `install.json` records is in `pg18` or holds no PGlite data yet (a new install). It runs recovery,
  the first start, the update check and the update the person accepts, with the same halt (exit
  code 3) and the same messages, output in `launcher.log`; no Node. Data still only in PGlite keep
  `run-current.mjs` (TypeScript, Node), and so does a cluster `--prepare-only` made that the move has not filled yet (`pg18.pending-move`), which the Go launcher also refuses. `-Go` / `--go` asks for the Go launcher only: it refuses,
  starting nothing, a version without `--go` and data not moved yet. A SIPGES already running is
  reused only in the install's mode.
- **Moving the data.** The data move into `pg18` is `<version>/go/sipges-desktop --move-pglite`
  ([the migration README](migration/README.md#into-postgresql-18-for-the-go-api-adr-0036-4)), with
  no Node: it runs the pinned PGlite 0.5.15 WebAssembly the `--go` package ships in `go/pglite`
  (SHA-256 checked) inside Go, on a copy of the state folder, into a running cluster
  (`migration/pglite-to-postgres.mjs` is the same move in Node, for a release without `go/pglite`); the original PGlite folder is never written, so setting
  `pg18` aside goes back to TypeScript. The move needs an **empty** database: `sipges-desktop
  --install <root> --prepare-only` makes the cluster with the roles and an empty database (no
  migration; the Go launcher migrates when it starts) and stops it; the bundled `pg_ctl` runs it
  for the move ([the visit](../../docs/deployment/desktop-visit.es.md), G3–G4).
- **Rehearsal.** The workflow's go-mode job runs `windows/go-drill.mjs` on `windows-latest` as the
  runner's standard user, synthetic data only: the package built with `--go` (bundle cached by its
  SHA-256) and a second release one version newer, `install.ps1 -Release` with no Node on the PATH,
  an install still on PGlite kept on TypeScript by `start.ps1`, `start.ps1 -Go` refused before the
  move, the move (`--prepare-only`, `pg_ctl`, `sipges-desktop --move-pglite` with no Node and its table-by-table proof), `start.ps1` (no Node) running the Go launcher with
  `sipges-desktop --compare` (no Node) finding no difference against its own `--snapshot`, and
  `compare.mjs` against it as the one Node cross check, the launcher killed during writes and started again, the
  update offered and applied by the Go launcher, a clean Ctrl+C stop (`windows/go-console.ps1`), the
  original PGlite folder byte-identical, and the way back to TypeScript with `pg18` set aside. By
  hand, on another Windows computer, with Go and port 8000 free:
  `node deploy\desktop\windows\go-drill.mjs [--work <new folder>] [--logs <folder>]`.

## Back up and restore

The state folder is everything: the database is useless without `data-key`. It is
`%LOCALAPPDATA%\SIPGES` on Windows and `~/.local/share/sipges-local` on Linux, unless another
one was chosen for a managed install (`stateDir` in `install.json` of the install root). The
install root itself holds no data and is not backed up.

These are the steps of the drill run on Linux with synthetic data (closure-roadmap T11,
`deploy/desktop/migration/rehearse.mjs` step 7). On Windows, use PowerShell; `E:` is the
external disk.

Back up:

1. Stop SIPGES so no file is half-written. Managed install: `pkill -f run-current.mjs` (Linux),
   or end every `node` process in Task Manager (Windows), or restart the computer. Clone install:
   `pkill -f apps/api/src/main.ts`, or the same on Windows. `http://127.0.0.1:8000/health` must
   no longer answer.
2. Copy the whole state folder to an external disk or encrypted storage you control, in a folder
   named with the date and, for a managed install, the version in `current.json` of the install
   root: `cp -a ~/.local/share/sipges-local /media/<disk>/SIPGES-<date>-<version>` (Linux),
   `Copy-Item -Recurse "$env:LOCALAPPDATA\SIPGES" "E:\SIPGES-<date>-<version>"` (Windows).
3. Check that the copy has the same number of files and bytes as the original:
   `find <folder> -type f -printf '%s\n' | awk '{n++; s+=$1} END {print n, s}'` on each (Linux),
   `Get-ChildItem -Recurse -File <folder> | Measure-Object -Property Length -Sum` on each
   (Windows: `Count` and `Sum`).
4. Open SIPGES again.

Restore:

5. Stop SIPGES as in step 1.
6. If the state folder is still there, rename it aside (add `.damaged`); never delete it. (The
   drill deleted it to stand for a lost disk.)
7. Copy the backup back to the same path, as the same user:
   `cp -a /media/<disk>/SIPGES-<date>-<version> ~/.local/share/sipges-local` (Linux),
   `Copy-Item -Recurse "E:\SIPGES-<date>-<version>" "$env:LOCALAPPDATA\SIPGES"` (Windows).
   Restore only a backup taken with the version now installed. A backup from an older version
   (one taken before the first start, or before an update) would be opened by the newer version
   directly, without a copy and a test run first. To restore one, before step 8 rename
   `first-start.json` in the install root aside (add `.done-<date>`; delete nothing) and run
   `node <root>/versions/<version>/updater/update.mjs --install <root> --first-start`: it copies
   the restored folder beside itself and tests the version on a second copy first, as the first
   start did.
8. Open SIPGES, sign in with the password and an MFA code, and open a few records and uploads.
   To check everything, run `deploy/desktop/migration/snapshot.mjs` before step 1 and
   `compare.mjs` after this step, as the drill did: it must print `RESULT: no difference`.
   A version with the Go mode does the same without Node: `sipges-desktop --snapshot` and
   `sipges-desktop --compare` take the same options and write and read the same file.
   `compare.mjs` only compares against a managed install; against a clone install it refuses
   with `RESULT: not compared (…)` and exit code 2.

Anyone who gets the folder gets your data and the key to read it. Keep copies private.

## Optional: local AI

Semantic search uses a local [Ollama](https://ollama.com/) server and stays on your computer.
Install Ollama, run `ollama pull nomic-embed-text`, then set the user environment variables
`SIPGES_OLLAMA_URL=http://127.0.0.1:11434` and `SIPGES_SEMANTIC_SEARCH=1` and restart the server.
Variable details: [docs/deployment/local-install.md](../../docs/deployment/local-install.md).

## Optional: Claude Desktop through MCP

SIPGES answers MCP on `http://127.0.0.1:8000/mcp` with seven read-only tools (`list_object_types`,
`search_records`, `get_record`, `get_links`, `get_timeline`, `count_records`, `get_briefing`). `count_records`
answers totals and counts grouped by a closed-list field, for reports, without reading record by record. On the Go API (the
desktop install moves to it at the laptop visit) an eighth tool, `report_period`, takes the period in words («este mes», «el
año pasado»), turns it into Lima days in code, and can answer a series by day or month or a CSV ready to save. Claude Desktop reaches it through the
`mcp-remote` bridge, which runs on this computer. Unlike semantic search, **this sends project data to Anthropic**:
names are pseudonymised and only allowed fields leave ([ADR 0030](../../docs/adr/0030-external-ai-egress-guard.md)),
but it is still personal data under Ley 29733, so the data owner must agree first.

1. In SIPGES, as an administrator: **Integraciones › Nueva clave de API**, «Solo lectura». Copy the key; it is shown
   once.
2. In **Configuración**, card «IA externa», turn on «Envío a IA externa». While it is off, `list_object_types`
   answers and every data tool returns «El envío a IA externa está desactivado para este proyecto».
3. Install [Claude Desktop](https://claude.ai/download). Node.js is already there from the install.
4. Claude Desktop › Settings › Developer › Edit Config opens `claude_desktop_config.json`
   (`%APPDATA%\Claude\` on Windows). Add:

   ```json
   {
     "mcpServers": {
       "sipges": {
         "command": "npx",
         "args": ["-y", "mcp-remote@0.15.2", "http://127.0.0.1:8000/mcp", "--header", "Authorization:${SIPGES_AUTH}"],
         "env": { "SIPGES_AUTH": "Bearer <the key>" }
       }
     }
   }
   ```

   No space after `Authorization:`: Claude Desktop on Windows splits arguments on spaces, so the space lives in
   the variable. The version is pinned on purpose; update it deliberately.
5. Quit Claude Desktop completely (also from the tray) and open it again. Ask «¿Qué tipos de objeto tiene
   SIPGES?».

SIPGES must be running: closing its window keeps the server up, restarting Windows does not. The key is stored in
plain text in that file; revoke it in **Integraciones** if the file or a screenshot of it leaves the computer.
Every answer is written to **Auditoría** under «IA externa».

## Change the icon

`sipges.svg` is the source. Regenerate the other two files from `deploy/desktop` (needs
`rsvg-convert` and ImageMagick's `magick`; run it with `bash`):

```sh
tmp=$(mktemp -d)
for size in 16 24 32 48 64 128 256; do
  rsvg-convert -w $size -h $size sipges.svg -o "$tmp/$size.png"
done
magick "$tmp"/{16,24,32,48,64,128,256}.png sipges.ico
rsvg-convert -w 512 -h 512 sipges.svg -o sipges.png
rm -r "$tmp"
```

## Limits to know

- **Windows was not tested on a real Windows machine by this change.** The scripts follow
  Windows PowerShell 5.1 and standard Windows tools, and are checked statically only. If
  something fails, `api.log` and the message box are the first clues.
- Windows opens Microsoft Edge in app mode (always installed). Linux opens the first of Chrome,
  Chromium, Edge or Brave it finds, otherwise your default browser (a normal tab, no app window).
- The port is fixed at 8000. If another program uses it, SIPGES cannot start.
- A console window may flash for a moment when the Windows shortcut starts.
- The managed install was run end to end on Linux only (install, open from the launcher entry, see
  the notice, update, halt and way out, the data move from an older clone install and the backup
  drill). On Windows, `install.ps1 -Release` and
  `start-managed.ps1` were checked statically; the Windows rehearsal in
  [README.es.md](README.es.md#ensayo-en-windows-para-la-visita-roadmap-t34) is their first run.
- The visit to the laptop that already holds real data follows the printed runbook
  [docs/deployment/desktop-visit.es.md](../../docs/deployment/desktop-visit.es.md) (Spanish).
  It installs beside the clone install, on a copy of the state folder, and says how to go back.
