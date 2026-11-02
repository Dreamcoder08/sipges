# Rotating `SIPGES_DATA_KEY`

How to replace the data key without breaking anyone's MFA or an automation channel. The API
reads with two keys while a tool re-encrypts the stored values, so the rotation is staged and can
be rolled back until the last step. Names only: no key value belongs in this guide, a ticket,
a commit or a chat.

## What the key protects

| Use | Where | Effect of the rotation |
| --- | --- | --- |
| Sealed TOTP secrets (AES-256-GCM, [ADR 0004](../adr/0004-identity-and-session-security.md)) | `users.totp_secret_sealed`, global table | Re-encrypted by the tool; nobody enrols again |
| Sealed channel settings (URL, token, signing secret; ADR 0014) | `integration_channels.sealed_config`, per project under RLS | Re-encrypted by the tool, one transaction per project |
| Per-project pseudonym keys ([ADR 0030](../adr/0030-external-ai-egress-guard.md)) | Derived from the current key, never stored | Every pseudonym changes when the new key goes live (step 2). Nothing to migrate, but an external AI client sees new tokens, and pseudonyms quoted in earlier egress audit rows or answers no longer match new ones |

Values carry no key id: `v1.<nonce|ciphertext|tag>`. The API seals with `SIPGES_DATA_KEY` and,
when `SIPGES_DATA_KEY_PREVIOUS` is set, also opens values sealed with that key (the GCM tag
rejects the wrong key, so trying both is unambiguous).

## Where the key lives

- **Production:** Worker secret `SIPGES_DATA_KEY` of the Worker `sipges` (Cloudflare dashboard ›
  Workers & Pages › `sipges` › Settings › Variables and Secrets, or
  `pnpm exec wrangler secret list` in `apps/hosting-cloudflare`). Secrets are write-only there:
  the value cannot be read back.
- **The only readable copy:** the owner's password manager. Keep the old key there too until
  every database backup taken before the rotation has expired (see [Retire the old key](#5-retire-the-old-key)).

## The tool

```sh
pnpm --filter @sipges/api rotate:data-key            # dry-run: counts only, writes nothing
pnpm --filter @sipges/api rotate:data-key -- --apply # re-encrypt
pnpm --filter @sipges/api rotate:data-key -- --report rotation.json
```

| Variable | Value |
| --- | --- |
| `SIPGES_DATA_KEY` | The **new** key |
| `SIPGES_DATA_KEY_PREVIOUS` | The **old** key (required by the tool) |
| `SIPGES_DATABASE_URL` | The direct (unpooled) Neon connection string, the same database `SIPGES_MIGRATION_DATABASE_URL` points at |

Keys are read only from the environment, never from arguments. What it guarantees:

- **Dry-run by default.** It prints, per table, column and project: total, `current` (opens with
  the new key), `stale` (opens with the old key), `unreadable` (opens with neither) and
  `rewritten`. Output holds counts, usernames and channel ids, never plaintext or keys.
- **All or nothing on a wrong key.** A read-only pass classifies every value first; one
  `unreadable` value anywhere stops the run (exit 1) before any write.
- **One transaction per unit** (the users table, then each project's channels) with the rows
  locked. Each new value is decrypted again before it is written, the update only applies if the
  row still holds the value that was read, and every value of the unit must open with the new
  key before commit; otherwise the unit rolls back.
- **Idempotent and resumable.** Values that already open with the new key are skipped. A second
  run reports `rewritten 0`; after an interruption, run it again.

Exit codes: `0` done, `1` aborted or stopped, `2` old key missing. The tool's own errors name
the table and project; a database error prints only its message. Either way the failed unit
rolled back, and a dry-run shows what is still `stale`.

## Procedure

Run it from a trusted machine with a fresh checkout of `main`, at a quiet hour, in **bash** (the
snippets are not fish syntax: start `bash` first). `read -rs` keeps the keys and the database
URL out of shell history and process lists.

### 1. Prepare

1. Take a Neon restore point (a branch from the console, ADR 0029) and note its time.
2. Generate the new key and store it in the password manager **before** anything else:
   `openssl rand -base64 32`.
3. Load both keys in the shell:

   ```sh
   read -rs OLD_KEY   # paste the current key
   read -rs NEW_KEY   # paste the new key
   read -rs SIPGES_DATABASE_URL && export SIPGES_DATABASE_URL   # direct Neon URL
   ```

### 2. Stage: the API reads both keys

Set both secrets in one request, so there is never a moment with only one of them
(`printf` is a shell builtin: the values do not reach the process list):

```sh
cd apps/hosting-cloudflare
printf '{"SIPGES_DATA_KEY":"%s","SIPGES_DATA_KEY_PREVIOUS":"%s"}' "$NEW_KEY" "$OLD_KEY" \
  | pnpm exec wrangler secret bulk
```

`wrangler secret bulk` deploys a new version of the Worker. Check: `/health/ready` answers 200
and an account with MFA signs in. New enrolments and channels are now sealed with the new key.

### 3. Re-encrypt

```sh
cd ../api
SIPGES_DATA_KEY="$NEW_KEY" SIPGES_DATA_KEY_PREVIOUS="$OLD_KEY" pnpm run rotate:data-key
```

Read the dry-run: `unreadable` must be 0 everywhere. If not, stop: either the old key is wrong,
or a value was already unreadable before the rotation (that factor already fails today). Reset
that person's MFA in Administración › Cuentas («Restablecer MFA») or delete and recreate the
listed channel in Integraciones, then dry-run again. Then:

```sh
SIPGES_DATA_KEY="$NEW_KEY" SIPGES_DATA_KEY_PREVIOUS="$OLD_KEY" pnpm run rotate:data-key -- --apply
SIPGES_DATA_KEY="$NEW_KEY" SIPGES_DATA_KEY_PREVIOUS="$OLD_KEY" pnpm run rotate:data-key
```

The last dry-run must show `stale 0` in every row.

### 4. Finish: the API stops reading the old key

```sh
cd ../hosting-cloudflare
pnpm exec wrangler secret delete SIPGES_DATA_KEY_PREVIOUS
unset OLD_KEY NEW_KEY SIPGES_DATABASE_URL
```

Check again that an account with MFA signs in and that a channel test send works.

### 5. Retire the old key

Keep the old key in the password manager, labelled with the rotation date, while any backup or
Neon restore point from before step 3 exists: restoring one brings back values sealed with it.
To use such a backup, restore it and repeat steps 2–4 with that old key.

## Rollback

| When | What to do |
| --- | --- |
| After step 2, before step 3 | Put the old key back alone: `printf '{"SIPGES_DATA_KEY":"%s","SIPGES_DATA_KEY_PREVIOUS":null}' "$OLD_KEY" \| pnpm exec wrangler secret bulk`. Anything enrolled since step 2 is sealed with the new key and fails; reset that MFA |
| During or after step 3, before step 4 | Swap the keys in one request (`SIPGES_DATA_KEY` = old, `SIPGES_DATA_KEY_PREVIOUS` = new), then run the tool with the same swap. It re-encrypts everything back to the old key; then delete `SIPGES_DATA_KEY_PREVIOUS` |
| After step 4 | Same as the row above, starting by setting both keys again |
| The tool stopped mid-run | Nothing is half-written: the failed unit rolled back and finished units are valid under the new key, which the API already reads. Fix the cause and run it again |

Pseudonyms follow whichever key is current; a rollback brings the old ones back.
