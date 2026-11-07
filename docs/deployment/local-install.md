# SIPGES on your own computer

This guide installs SIPGES on one computer in your office, so everyone on your network uses it from a browser. You do not need to be a developer. You run a few commands, and each one tells you what happened.

Everything lives on that computer: the data, the evidence files and the backups. Nothing is sent to Neon or Cloudflare.

## What you need

| Need | Detail |
| --- | --- |
| A computer that stays on | Linux on an Intel or AMD processor. Windows only through WSL 2, not tested yet. ARM computers are not supported yet. |
| Memory | 4 GB. SIPGES itself used about 130 MB at rest in our test, but the first build and reading large PDFs need more. |
| Docker | [Docker Engine](https://docs.docker.com/engine/install/) with the Compose plugin, version 2.24 or later. |
| Internet | For the first install and for updates. Not needed to use SIPGES afterwards, except for map tiles. |
| A folder for this project | A copy of the SIPGES repository. The commands run from `deploy/local`. |

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

## If something goes wrong

| What you see | What to do |
| --- | --- |
| `Docker is not running` | Start Docker, or add your user to the `docker` group and sign in again. |
| Browser says the certificate is not trusted | Install `sipges-root-ca.crt` on that computer. After `./sipges wipe` the certificate is new, so install it again. |
| A blank page | You used a different name or address from the install. Use that one, or change it with `./sipges install <new name>`. |
| The status shows a backup failure | Run `./sipges logs backup`. Disk space is the usual cause. |
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
| `restore`, `import` | Started only by their commands. |

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

Push, Google sign-in, Ollama and the analyst provider stay off until their variables are in `.env`; `compose.yaml` lists the names. None of them has been tried on this install.

### Tests

```bash
deploy/local/test/unit.sh                         # the script against a stand-in for Docker, under a minute
deploy/local/test/drill.sh [work folder]          # install, MFA, record, evidence, backup, wipe, restore
deploy/local/test/import-drill.sh [work folder]   # both import paths on synthetic files
```

Both use their own project and ports, only synthetic data, and clean up after themselves. Run `./sipges build` first, or set `SIPGES_DRILL_BUILD=1` for `drill.sh`.

### What is not included yet

| Gap | Effect | Size |
| --- | --- | --- |
| OCR | Scanned PDFs yield no text: the image has no `ocrmypdf`. It adds 289 MiB and a Debian base. | Medium |
| Prebuilt images | Each client builds from source and needs the repository. Publishing images, or `docker save` for a machine with no internet, would remove that. | Medium |
| ARM computers | The API image is `linux/amd64` only. | Medium |
| Windows | `./sipges` is a Bash script. WSL 2 should work; nobody has tried it. | Small |
| Excel or CSV bulk import | Not offered by any tool. | Medium |
| Spanish version of this guide | Written in English. | Small |
| `vapid:keys` | The generator of push keys is TypeScript. Generate them anywhere, then set the `SIPGES_VAPID_*` variables in `.env`. | Small |

No API route is missing: every TypeScript route has a Go handler. `rotate-data-key` and `review-materialize` exist in Rust but are not in the import image.
