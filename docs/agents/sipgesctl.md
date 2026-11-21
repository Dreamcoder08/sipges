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
  stdin, typed unseen at a `Password:` prompt on a terminal (through `stty`; without it, set the
  variable); the code from `--totp-secret-file`, `SIPGES_TOTP` or the next line of stdin.
- `sipgesctl password` changes your own password. The current and the new password come from stdin,
  one per line, or are typed unseen at the `Current password:` and `New password:` prompts; never
  from a flag or a variable. The API (`POST /system/auth/password`) answers 204, keeps this session
  and ends your other sessions. A wrong current password answers `Credenciales inválidas` (exit 6)
  and counts toward the sign-in throttle. The new password must have 12 to 128 characters and
  must not be your username, your current password or a common password; each refusal says which
  rule failed (exit 6).
- The TOTP secret goes to a new private file and is never printed.
- Fields that hold a credential (`token`, `secret`, `password` and others) print as `[redacted]`
  on every command, the generic call included. `apikey create --secret-file FILE` keeps a new key,
  which the API shows only once, in a private file. The file is created first, so a bad path issues
  no key, and a key that still cannot be written is revoked.
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

An administrator renames a project they use with `project rename` (`PATCH /system/auth/scopes`).
The name is trimmed and cut to 120 characters; a blank name is refused with exit 6, and a project
the account has no access to answers as a missing one (exit 5). The project's audit trail records
the old and new names.

```sh
printf '%s' '{"company_id":"ACME","project_id":"NORTE","label":"Proyecto Norte"}' \
  | ./sipgesctl project rename --body -
```

`analyst ask` puts one question to the Inicio analyst (`POST /system/analyst/ask`). With `--steps`
it asks `POST /system/analyst/ask/stream` instead and prints each step on stderr as it happens
(«Buscando registros…», «Leyendo la línea de tiempo…»: a fixed label per tool call, never its input
or result); the answer then reaches stdout exactly as without `--steps`, and an error has the same
exit code and text as the JSON route's status. `--steps` refuses `--output`, `--form`, `--field`
and `--attach`.

```sh
printf '%s' '{"question":"¿Qué alertas rojas siguen abiertas?"}' | ./sipgesctl analyst ask --body - --steps
```

A follow-up question carries the earlier turns as `history`: at most 6 turns and 8,000 characters,
each `{"question": …, "answer": …}`, oldest first. `--follow-up FILE` adds them from a JSON list in
a file; a body that already has a `history` is refused. The API scrubs them like the question and
logs them in the same release, drops their `[n]` markers, and stores none of them; a record they
name must be read again to be cited. A history past its limits answers 422.

```sh
printf '%s' '[{"question":"¿Qué alertas rojas siguen abiertas?","answer":"Dos, en el norte [1][2]."}]' > history.json
printf '%s' '{"question":"¿Cuál es la más antigua?"}' | ./sipgesctl analyst ask --body - --follow-up history.json
```

The stream sends `event: step` `{"label": …}` per tool call, then one `event: answer` with the body
`/ask` answers or one `event: error` `{"status": …, "detail": …}` (409, 422, 502, 503 or 504), then
`event: done`, with a `: ping` comment after 15 s of quiet. The answer text is never streamed as
the model writes it: its citations are checked on the whole answer first. A client that leaves
stops the loop, and the API logs it as 499.

Machine routes (`/mcp`, `/hooks/*`, the cron route) take `SIPGES_MACHINE_TOKEN` and never the
session:

```sh
./sipgesctl apikey create --name bot --access write --secret-file ~/.config/sipges/bot-key
SIPGES_MACHINE_TOKEN=$(cat ~/.config/sipges/bot-key) ./sipgesctl call POST /mcp --body request.json
```

A report over a period said in words, as Claude Desktop would ask it (`report_period`, Go API only; a read key is
enough):

```sh
printf '%s' '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"report_period",
  "arguments":{"module":"eventos","period":"este mes","group_by":"Tipo_Evento","format":"csv"}}}' |
  SIPGES_MACHINE_TOKEN=$(cat ~/.config/sipges/read-key) ./sipgesctl call POST /mcp --body -
```

The answer names the range «este mes» became (`period.from`, `period.to`, in Lima days) and carries the CSV in `csv`.

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
| machine-routes | A key reaches `/mcp` and writes into its own project, the session does not, a revoked key stops, and a webhook alone wakes a rule of its project |
| tenant-isolation | A second tenant sees nothing and can change nothing; naming the other project in a header, query or body is refused. Every read is compared with project A, because a read that shows nothing proves nothing unless the owner sees the data |
| read-only-role | A read-only role is refused on every route that writes, and never sees a restricted record |
| route-sweep | Every route of the inventory answers, nothing opens without its credential, and no read answers a server error (a 502 or 504 from a read marked `"upstream": true` in `routes.json`, such as the Defensoría preview, means the external site did not answer and is not counted) |
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
