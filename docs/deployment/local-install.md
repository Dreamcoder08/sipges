# SIPGES on your own computer

This guide installs SIPGES on one computer in your office, so everyone on your network uses it from a browser. You do not need to be a developer. You run a few commands, and each one tells you what happened.

Everything lives on that computer: the data, the evidence files and the backups. Nothing is sent to Neon or Cloudflare.

[Versión en español](local-install.es.md)

## What you need

| Need | Detail |
| --- | --- |
| A computer that stays on | Linux on an Intel or AMD processor. Windows only through WSL 2, not tested yet. ARM computers are not supported yet. |
| Memory | 4 GB. SIPGES itself used about 130 MB at rest in our test, but the first build and reading large PDFs need more. |
| Docker | [Docker Engine](https://docs.docker.com/engine/install/) with the Compose plugin, version 2.24 or later. |
| Internet | For the first install and for updates. Not needed to use SIPGES afterwards, except for map tiles. |
| A folder for this project | A copy of the SIPGES repository. The commands run from `deploy/local`. |

## Encrypt the disk

SIPGES encrypts its backups, but the database and the evidence files sit unencrypted on this computer. If someone takes the computer or its disk, only disk encryption protects them.

Turn on disk encryption when you install the system; on Ubuntu and Debian the option uses LUKS. A system already installed without it usually needs a reinstall. Encrypt external disks that hold backups or client files too.

Someone must type the disk password after every power cut or restart, and SIPGES stays off until then. Nobody can recover the disk without that password, so keep it with your copy of `.env`. To check, run `lsblk -o NAME,TYPE,FSTYPE,MOUNTPOINT`: an encrypted disk shows `crypto_LUKS`.

## Install

```bash
cd deploy/local
./sipges install sipges.local
```

Use the name people will type in the browser. It can be a name like `sipges.local` or the computer's fixed address, like `192.168.1.20`. Your network must send that name to this computer, which is usually one line in the router's settings. Without a name, `./sipges install` uses `localhost`, which works only on the computer itself.

If your client is bringing existing data, do not run this yet: read [Bringing in the client's data](#bringing-in-the-clients-data) first. An old SIPGES installation must go into a database the app has never touched, and `./sipges install` starts the app.

The first install takes a few minutes. At the end it prints the address, the user `admin` and a password. Then:

1. Open the address and sign in.
2. Add SIPGES to an authenticator app when asked. Every account must use one.
3. **Copy `deploy/local/.env` somewhere safe, away from this computer.** See [the two things you must not lose](#the-two-things-you-must-not-lose).

To change the address later, run `./sipges install <new name>` again. Nothing else changes.

## Make the browser trust the connection

SIPGES always uses HTTPS, so passwords never cross your network unprotected. On a private network nobody can buy a public certificate for your name, so the install creates its own small certificate authority. Each computer must trust it once.

```bash
./sipges ca
```

This writes `sipges-root-ca.crt`. Install that file on each computer:

| System | How |
| --- | --- |
| Windows | Double-click it, choose **Install certificate**, then **Local machine**, then **Trusted Root Certification Authorities**. |
| macOS | Double-click it, add it to **System** in Keychain Access, open it there and set **Always Trust**. |
| Linux, Chrome | **Settings > Privacy and security > Security > Manage certificates > Authorities > Import**. |
| Firefox, any system | **Settings > Privacy & Security > Certificates > View Certificates > Authorities > Import**. |
| Android, iPhone | Send the file to the phone and install it as a CA certificate in Settings. iPhone also needs it turned on under **Certificate Trust Settings**. |

Until you do this, browsers show a warning, and the app cannot install itself or work offline.

**Do not share port 443 with the internet.** This setup is for a private network. If people need it from outside, use a VPN.

## Every day

| Command | What it does |
| --- | --- |
| `./sipges status` | Shows what is running, the latest backup, and any backup failure. |
| `./sipges stop` / `./sipges start` | Stops or starts everything. It also starts by itself after a restart of the computer. |
| `./sipges logs api` | Shows recent activity. Other parts: `db`, `caddy`, `backup`. |

Check `./sipges status` once a week. It is how you find out a nightly backup failed.

## Backups

SIPGES backs itself up every night at 2:00, Lima time, and keeps the latest 14. A backup holds the database and every evidence file, encrypted. It counts only after SIPGES has read it back.

Backups are in `deploy/local/backups`. **A backup on the same computer does not protect you from a dead disk.** Copy that folder to an external disk or another computer regularly.

| Command | What it does |
| --- | --- |
| `./sipges backup` | Takes a backup now. |
| `./sipges backups` | Lists the backups by date. |
| `./sipges restore 20261106T193243Z` | Replaces everything with that backup. Asks you to type RESTORE. |

To change the hour, the number kept or the time zone, edit `SIPGES_BACKUP_HOUR`, `SIPGES_BACKUP_KEEP` and `SIPGES_TIMEZONE` in `.env`, then run `./sipges start`.

A restore loads the backup into a separate database first. With a wrong passphrase or a damaged file it stops, and SIPGES comes back with the data it had. If it stops later, for example in a power cut, SIPGES stays off and says so: run the same `./sipges restore` again and it finishes. Until then, no other backup can be restored. What was replaced stays on the disk until the next restore. Sign in afterwards with the authenticator codes you already use.

### The two things you must not lose

`.env` holds `SIPGES_BACKUP_PASSPHRASE` and `SIPGES_DATA_KEY`.

- Without the passphrase, no backup can be opened by anyone.
- Without the data key, authenticator setups and stored channel secrets cannot be read.

Keep a copy of `.env` in a safe place, separate from the backups. Anyone with both `.env` and the backups has all the data.

### Moving to a new computer

Install Docker, copy the repository, your `.env` and the `backups` folder to the same places, then run:

```bash
./sipges install
./sipges restore <name of the latest backup>
./sipges ca
```

The new computer has a new certificate, so install `sipges-root-ca.crt` on every computer again. Browsers refuse the old address until you do.

## Updating

```bash
./sipges update
```

It takes a backup, gets the new version, rebuilds and restarts. Database changes apply by themselves.

### Going back

`previous` is the last version that really started, so a failed update, even retried, never replaces it. If an update goes wrong:

1. Run `./sipges backups` and note the backup taken just before the update.
2. Add `SIPGES_IMAGE_TAG=previous` to `.env`.
3. Run `./sipges restore <that backup>`.

The restore matters: database changes only go forward, so the old version needs the old database. Remove the line from `.env` when the fixed version is out.

## Bringing in the client's data

The client's files stay in a folder **outside** the SIPGES folder, for example a USB disk at `/media/usb/client`. SIPGES reads that folder and never writes to it. Every import only tries unless you add `--apply`, and `--apply` takes a backup first.

### First, see what the folder holds

Before planning any import, ask SIPGES what is in the folder:

```bash
./sipges inventory /media/usb/client
```

This changes nothing: the folder is mounted read-only, in a container with no network and no access to the database. It works on anything an install has built, so `./sipges prepare` is enough. A file SIPGES cannot read is not a problem here; it becomes a line of the report.

The screen shows counts only. The full report is a JSON file in `deploy/local/imports`:

| Part | What it says |
| --- | --- |
| `totals`, `byType`, `byReason` | How many files of each type, their size, how many can be read, and why the others cannot. |
| `duplicates` | Files with identical bytes, found by SHA-256. |
| `tables` | For each XLSX and CSV file: sheet names, column headers, and row counts. Never a cell value. |
| `files` | Every file with its path, size, hash and verdict. |

| Verdict | Meaning |
| --- | --- |
| `readable` | SIPGES opened it. For a PDF this does not mean it has text: a scanned PDF is readable and still has no text. |
| `not-inspected` | A type this report does not open, such as images. It is counted and hashed. |
| `encrypted` | Protected with a password. Ask the client for an open copy. |
| `legacy-format` | An old `.doc`, `.xls` or `.ppt`. Save it in the new format from Office. |
| `corrupt` | Damaged, or not really the format its name claims. |
| `empty`, `too-large`, `permission-denied`, `link`, `special-file` | Empty, beyond the safety limits, closed to SIPGES, a link (never followed), or not a regular file. |

A column header is itself a cell, and nothing in a file can prove a first row is not a person's data: `Juan Perez` above a column of numbers reads exactly like `Monto`. So by default SIPGES shows a header only when Excel itself marks that row, with a filter or a frozen pane. Everything else, every CSV included, says `headersWithheld: unconfirmed` and still gives its row and column counts.

After you have looked at those files yourself, ask for the rest:

```bash
./sipges inventory /media/usb/client --show-unconfirmed-headers
```

That report may hold real data if a file has no header row. A cell that looks like a value, such as a document number, an email or a date, shows as `[withheld]` in both reports, but that guard cannot catch a name. **Read it yourself before you share it with anyone or any tool.**

**Treat the report as private as the files.** It holds no cell values, but file names, sheet names and column names can hold a client's or a person's name. Read it before you share it with anyone or any tool.

### Which files are accepted

| What the client has | Command | Accepted format |
| --- | --- | --- |
| A folder from the old SIPGES installation | `import legacy` | A folder holding `data/auth_global.db` and `data/sipges.db`, both SQLite, plus optional per-project databases, `irsa_config.json` files and the `data/uploads` files. |
| The Base Maestra matrix | `import base-maestra` | One UTF-8 JSON file shaped `{"Módulo": [{...}, {...}]}`, without a byte order mark. |

**Excel, CSV, Word and PDF files are not imported in bulk.** Convert a spreadsheet to the Base Maestra JSON first, or ask for a converter. Single PDF, Word, Excel, CSV, image and text files can still be attached as evidence inside the app.

SIPGES reads the folder through your own user's group, so nobody else on this computer needs access. If the import says `SIPGES cannot read`, copy the folder to this computer, then run on the copy:

```bash
chgrp -R "$(id -gn)" /path/to/copy
chmod -R u+rwX,g+rX,o-rwx /path/to/copy
```

A USB disk may need this. Never change the permissions on the client's original. If the import warns that other users can read the folder, the second command closes it on a copy.

If the import says the group is shared with other accounts, your computer gives several users one group, and they could read the client's files. Create an account for SIPGES with `sudo adduser sipges`, add it to the `docker` group, and run everything from that account.

### An old SIPGES installation

This path needs a database the app has never used, so run it **instead of** `./sipges install`:

```bash
./sipges prepare sipges.local
./sipges import legacy /media/usb/client            # tries, writes nothing
./sipges import legacy /media/usb/client --apply    # writes
./sipges import legacy /media/usb/client --verify   # compares both sides
./sipges start
```

Each run prints a line per table: rows in the file, rows usable, rows written and rows now in the database. Fix or accept every problem it names before `--apply`. People sign in with their old passwords and set up an authenticator if they had none. Sessions are not moved. The default project comes from the client's data.

If the app has already started, even without anyone signing in, the import refuses and writes nothing. Start again from an empty install: `./sipges wipe`, then `prepare`.

If `--apply` fails partway, the accounts may be in the database with no records, and a second try refuses. Fix what the report names, then run `./sipges wipe`, `./sipges prepare` and the import again. The backup `--apply` took does not help here: restoring it starts the app.

The path overrides of the tool also work: `--auth-db`, `--default-db`, `--tenant-dir`, `--upload-dir`, `--config-dir`, and `--only COMPANY/PROJECT`. Paths are inside the folder, starting with `/import`. The [migration runbook](../migration/data-migration.md) explains every problem code.

### A Base Maestra file

This works any time, on a running install:

```bash
./sipges import base-maestra /media/usb/client/seed.json                    # tries
./sipges import base-maestra /media/usb/client/seed.json --apply            # writes
./sipges import base-maestra /media/usb/client/seed.json --scope C/P --apply  # another project
```

It prints, per module, the rows in the file, the new ones and those already there. It only inserts: a record that already exists is left as it is, so repeating the import is safe and never undoes an edit. Users, roles and projects in the file are ignored. A row naming another project stops the whole file before anything is written. See the [runbook](../migration/base-maestra.md).

## The authenticator of imported people

People sign in with their old password. Sessions are not moved, so everyone signs in again.

| The person | What happens | What to do |
| --- | --- | --- |
| Already used an authenticator | Their codes keep working: the secret moved, sealed with `SIPGES_DATA_KEY`. | Nothing. |
| Had none | SIPGES asks them to set one up at their first sign-in. | Have the phone at hand. |
| Lost the phone or the entry | They cannot sign in. | An administrator uses **Restablecer MFA** in Administración, inside the active project. |

**Restablecer MFA** clears the authenticator and closes all that person's sessions. They set up a new one at their next sign-in.

**Before using real data:** the old installation kept authenticator secrets unencrypted in `auth_global.db`, so anyone who held a copy of that folder could read them. If the folder travelled by USB or email, reset the MFA of every account after the import, and lock the USB away.

Do not change `SIPGES_DATA_KEY` by hand: authenticators could no longer be read.

## External credentials

SIPGES works in full with none of these. Each one turns on an optional feature, and none has been tried on this install yet, so check it before promising it. Those in `.env` apply with `./sipges start`; channels are typed inside the app.

| Feature | What you need | Where it goes | Condition |
| --- | --- | --- | --- |
| Google sign-in | A Google OAuth client | `.env`: `SIPGES_GOOGLE_CLIENT_ID`, `SIPGES_GOOGLE_CLIENT_SECRET`, optional `SIPGES_GOOGLE_ADMIN_EMAIL` | Google requires HTTPS and refuses IP addresses, so this needs a public domain. Authorize `https://<your domain>/auth/google/callback`. |
| Device notifications (push) | A VAPID key pair | `.env`: `SIPGES_VAPID_PUBLIC_KEY`, `SIPGES_VAPID_PRIVATE_KEY`, `SIPGES_VAPID_SUBJECT` | Generate once with `pnpm --filter @sipges/api vapid:keys` on any computer with the repository. Each device must trust the certificate, and the server needs internet. |
| Email | A [Resend](https://resend.com) key, a verified sender and up to 20 recipients | In the app, as an email channel | There is no SMTP option. The server needs internet. |
| Slack, Teams, Discord, Google Chat, Telegram | A webhook URL, or a bot token and chat for Telegram | In the app, as a channel | The server needs internet. |
| AI-assisted summary | An Anthropic key | `.env`: `SIPGES_ANALYST_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, optional `SIPGES_ANALYST_MODEL` | Information leaves for an outside service. Without it, the summary stays deterministic. |
| Semantic search | An Ollama server with an embedding model | `.env`: `SIPGES_OLLAMA_URL`, `SIPGES_OLLAMA_EMBED_MODEL`, `SIPGES_SEMANTIC_SEARCH=1` | The address must be reachable from the container, where `localhost` is the container itself. A remote Ollama gets pseudonymized text, and only with **Envío a IA externa** on. |

See [integrations](../integrations/README.md).

## If something goes wrong

| What you see | What to do |
| --- | --- |
| `Docker is not running` | Start Docker, or add your user to the `docker` group and sign in again. |
| Browser says the certificate is not trusted | Install `sipges-root-ca.crt` on that computer. After `./sipges wipe` the certificate is new, so install it again. |
| A blank page | You used a different name or address from the install. Use that one, or change it with `./sipges install <new name>`. |
| The status shows a backup failure | Run `./sipges logs backup`. Disk space is the usual cause. |
| `the database did not become ready` | Run `./sipges logs db`. After a power cut it may need a while to recover, so wait and try again. |
| `the app has already run here` | `prepare` is only for an unused install. To start over: `./sipges wipe`, then `./sipges prepare`. |
| `SIPGES did not become ready` | Run `./sipges logs api`, and keep the output for support. It holds no passwords. |
| Port 80 or 443 already in use | Set `SIPGES_HTTP_PORT` and `SIPGES_HTTPS_PORT` in `.env`, and add the port to the address. |

To remove everything from this computer, run `./sipges wipe`. Backups and `.env` stay until you delete them yourself.

## For the person maintaining this

### How it fits together

| Service | Role |
| --- | --- |
| `caddy` | HTTPS from its own authority, compression, and the only published ports. |
| `api` | `apps/api-go/Dockerfile` unchanged, plus the built web app and the migrations (`deploy/local/Dockerfile`). Read-only filesystem, no capabilities, 1 GiB limit. |
| `migrate` | `api migrate`, once on every start, before `api` and `backup`. |
| `db` | PostgreSQL 17, on a network with no route out and no published port. |
| `backup` | Nightly `pg_dump` and evidence archive, encrypted with AES-256 by GnuPG. |
| `restore`, `import`, `inventory` | Started only by their commands. `inventory` has no network and no settings. |

Go serves the web app itself (`SIPGES_WEB_DIR`), so the Worker's headers live in one tested place: CSP, HSTS, `no-store`, frame and referrer rules, with the host allowlist in front. On 23 requests its status, body and headers matched `createWebApp`; the only header it lacks is the trace header `traceresponse`. Caddy adds TLS only, and `SIPGES_TRUST_PROXY=1` is safe because nothing else reaches the API.

### Database roles

| Role | Attributes | Used by |
| --- | --- | --- |
| `sipges_app` | Owns the tables. No superuser, no `BYPASSRLS`, no `CREATEROLE`. | API, migrations, imports. Go refuses a privileged login. |
| `sipges_tenant` | No login. | The API sets it inside tenant transactions. |
| `mascli_tenant` | No login. | Only because migration 0003 names it. |
| `sipges_backup` | `BYPASSRLS`, reads only. | `pg_dump`, which cannot read tables under `FORCE ROW LEVEL SECURITY` otherwise. |
| `sipges_admin` | Superuser. Needs its password even on the database's own socket and loopback. | First-run setup and `restore` only. |

The import job shares the database's network, because the Rust tools require TLS unless the database is on loopback.

Push, Google sign-in, Ollama and the analyst provider stay off until their variables are in `.env`; `compose.yaml` lists the names, and [External credentials](#external-credentials) says what each needs.

### Tests

```bash
deploy/local/test/unit.sh                         # the script against a stand-in for Docker, under a minute
deploy/local/test/drill.sh [work folder]          # install, MFA, record, evidence, backup, wipe, restore
deploy/local/test/import-drill.sh [work folder]   # the inventory and both import paths on synthetic files
```

Both use their own project and ports, only synthetic data, and clean up after themselves. Run `./sipges build` first, or set `SIPGES_DRILL_BUILD=1` for `drill.sh`.

### What is not included yet

| Gap | Effect | Size |
| --- | --- | --- |
| OCR | Scanned PDFs yield no text: the image has no `ocrmypdf`. It adds 289 MiB and a Debian base. | Medium |
| Prebuilt images | Each client builds from source and needs the repository. Publishing images, or `docker save` for a machine with no internet, would remove that. | Medium |
| ARM computers | The API image is `linux/amd64` only. | Medium |
| Windows | `./sipges` is a Bash script. WSL 2 should work; nobody has tried it. | Small |
| Excel or CSV bulk import | Not offered yet. `./sipges inventory` gives the real columns to design it from. | Medium |
| `vapid:keys` | The generator of push keys is TypeScript. Generate them anywhere, then set the `SIPGES_VAPID_*` variables in `.env`. | Small |

No API route is missing: every TypeScript route has a Go handler. `rotate-data-key` and `review-materialize` exist in Rust but are not in the import image.
