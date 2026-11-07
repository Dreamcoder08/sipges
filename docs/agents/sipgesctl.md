# sipgesctl: prove behaviour through the CLI

`sipgesctl` is the SIPGES command line. It talks to a running API over HTTP, the way the web app
does, so sessions, MFA, roles, project scope and row-level security stay in the path of everything
it does. It imports only the Go standard library, and a test holds that: it has no way to reach a
table.

| Tool | What it is | Who uses it |
| --- | --- | --- |
| `deploy/local/sipges` | Runs an installation: Docker, backups, restore, import | The person who owns the machine |
| `sipgesctl` (`apps/api-go/cmd/sipgesctl`) | Signs in to an API and uses it | People and agents proving behaviour |

## The order of work

1. **CLI first.** Behaviour is proved through `sipgesctl` before any frontend work.
2. **Then the core library.** Business logic lives in `internal/<context>/{domain,application}`.
3. **Then the wrappers.** GUI, HTTP API and MCP call the library and hold no business logic.

Existing behaviour stays proved through the HTTP API, because that path also proves auth and
row-level security. Agents verify through the CLI, never by reading tables.

## Build and sign in

```sh
cd apps/api-go && go build -o sipgesctl ./cmd/sipgesctl
export SIPGES_URL=https://localhost:8443 SIPGES_CA_FILE=./ca.crt SIPGES_USERNAME=admin
read -rs SIPGES_PASSWORD && export SIPGES_PASSWORD
./sipgesctl login
./sipgesctl mfa enroll --secret-file ~/.config/sipges/totp      # first time only
./sipgesctl login --totp-secret-file ~/.config/sipges/totp
./sipgesctl session
```

Run `sipgesctl help` for every command.

## Secrets

- Passwords and codes have no flag. The password comes from `SIPGES_PASSWORD` or the first line of
  stdin; the code from `--totp-secret-file`, `SIPGES_TOTP` or the next line of stdin.
- The TOTP secret goes to a new private file and is never printed.
- Fields that hold a credential (`token`, `secret`, `password` and others) print as `[redacted]`
  on every command, the generic call included. `apikey create --secret-file FILE` keeps a new key,
  which the API shows only once, in a private file.
- The session is saved in `$XDG_STATE_HOME/sipges/session.json` with mode 0600. A file others can
  read is refused, and a session is never sent to an address other than its own.
- Plain `http://` is accepted only for a loopback address.

## Output and exit codes

`--json` prints one object on stdout, for success and failure alike:

```json
{ "schema": "sipgesctl/v1", "ok": false, "status": 403, "route": "GET /api/{module}",
  "error": { "code": "forbidden", "detail": "Proyecto fuera de alcance" } }
```

| Exit | Meaning |
| --- | --- |
| 0 | Done |
| 1 | A `verify` check failed, or an unclassified answer |
| 2 | Wrong command line, or a route outside the inventory |
| 3 | 401: not signed in |
| 4 | 403: role, project or MFA refuses it |
| 5 | 404 |
| 6 | 400, 409, 413, 415, 422 or 429: the API refused the input or the pace |
| 7 | 5xx |
| 8 | The API could not be reached |
| 9 | A local file could not be used |

An answer that is not JSON never reaches the terminal: `--output FILE` saves it, and without it
the CLI reports its type, size and SHA-256.

## Any route

`internal/cli/routes.json` lists every route the API serves. `sipgesctl routes` prints it, with
what reaches each route.

```sh
./sipgesctl call GET /system/irsa --project ACME/NORTE
./sipgesctl call POST /system/links --body link.json
./sipgesctl records create --module compromisos --body -  < record.json
./sipgesctl evidence upload --file acta.pdf --module compromisos --record C-1
./sipgesctl reports situational --output informe.docx
```

Request bodies come from a file or stdin, never from the command line. An option a command would
ignore is refused with exit 2.

Machine routes (`/mcp`, `/hooks/*`, the cron route) take `SIPGES_MACHINE_TOKEN` and never the
session:

```sh
./sipgesctl apikey create --name bot --access write --secret-file ~/.config/sipges/bot-key
SIPGES_MACHINE_TOKEN=$(cat ~/.config/sipges/bot-key) ./sipgesctl call POST /mcp --body request.json
```

**Adding a route.** `TestEveryRouteHasACLIPath` in `internal/app` reads the routes off the real
mux and fails CI when one is missing from the inventory, or listed and no longer served. Add an
entry to `routes.json`. Give it `command` and `summary` to make it a typed command: its path values
become flags by themselves. Nothing else is needed.

## verify

```sh
./sipgesctl verify --synthetic-target
```

It runs the whole journey as the signed-in administrator and prints `PASS` or `FAIL` per check;
exit 0 means every check passed, and `--json` gives the same verdict as data.

| Part | What it proves |
| --- | --- |
| anonymous, sign-in, projects, accounts, mfa | Nobody gets in anonymously, a foreign Origin is refused, projects and accounts are created, MFA gates data, and a used code is refused |
| records, prevention, evidence | Create, update, history, search, delete, dry-run import; an action needs a corroborated alert and closes only with evidence; file bytes and hash survive |
| reports, document-lab, management, automation, notifications | Reports download, the review queue moves, a rule fires and notifies, unread counts follow |
| machine-routes | A key reaches `/mcp` and writes into its own project, the session does not, and a revoked key stops |
| tenant-isolation | A second tenant sees nothing and can change nothing; naming the other project in a header, query or body is refused. Every read is compared with project A, because a read that shows nothing proves nothing unless the owner sees the data |
| read-only-role | A read-only role is refused on every route that writes, and never sees a restricted record |
| route-sweep | Every route of the inventory answers, nothing opens without its credential, and no read answers a server error |
| cleanup | The run's accounts are deactivated and cannot sign in |

It writes accounts, projects and records, so it runs only against a loopback address and only with
`--synthetic-target`. **Never run it on an install holding real data.** Each run uses new project
names and leaves its synthetic rows behind.

The API allows 20 failed sign-ins per address in 15 minutes and `verify` fails a few on purpose, so
about four runs in a row hit `429`. Wait, or start from a fresh install.

## The proof in CI

`deploy/local/test/cli-drill.sh` installs from `deploy/local` on empty volumes, then signs in, enrols
MFA and runs `verify` over real HTTPS against the real database roles, with synthetic data only. The
`Local install` workflow runs it.
