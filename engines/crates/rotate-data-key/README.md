# rotate-data-key (Rust)

Rust port of `apps/api/src/tools/rotate-data-key` (ODD go-rust-stack T43, ADR 0032). It re-encrypts
every value sealed with the old `SIPGES_DATA_KEY` under the new one. Procedure and production rule:
[docs/operations/data-key-rotation.md](../../../docs/operations/data-key-rotation.md).

```sh
cd engines && cargo build --release -p sipges-rotate-data-key
SIPGES_DATA_KEY=<new> SIPGES_DATA_KEY_PREVIOUS=<old> SIPGES_DATABASE_URL=… \
  target/release/rotate-data-key [--dry-run | --apply] [--report <file>]
```

The TypeScript tool stays until the owner retires it.

## Same as TypeScript

- Sealed format `v1.<base64url(nonce | ciphertext | tag)>`, AES-256-GCM with a random 12-byte
  nonce (`ring`): values sealed by either tool open with the other and with the API. Opening
  follows Node: only the first two dot-separated parts are read, base64url decoding is lenient
  (both alphabets, other characters skipped, stops at `=`), invalid UTF-8 plaintext becomes U+FFFD.
- Flags (`--dry-run` default, `--apply`, `--report <file>`, `--help`, a leading `--` dropped), the
  usage text, the summary lines, the JSON report, the «Rotation stopped» lines and exit codes
  (0, 1 on problems or a stop, 2 without `SIPGES_DATA_KEY_PREVIOUS`).
- The same units and transactions: a read-only preflight of every unit (users, then each tenant's
  channels in tenant order); one unreadable value stops the run before any write; with `--apply`
  each unit is one transaction with its rows locked (`FOR UPDATE`), compare-and-swap updates and a
  check that every value opens with the new key before commit. An interrupted run keeps the
  committed units and a re-run resumes. No migrations are applied (as in TypeScript).

## Known differences

| Case | TypeScript | Rust |
| --- | --- | --- |
| Errors the CLI does not catch (bad flags, `--apply --dry-run`, invalid keys) | Node's uncaught error with a stack trace, exit 1 | one line `<Name>: <message or code>`, exit 1 |
| `SIPGES_DATABASE_URL` unset | embedded PGlite | refuses, exit 1 |
| Other API settings invalid | `loadConfig` fails, exit 1 | ignored |
| Connection errors (not server errors) after «Rotation stopped:» | postgres.js wording | rust-postgres wording |
| `--report` write failures other than ENOENT, EACCES, EISDIR | Node's message | Rust's message |
| TLS to a non-local host; unknown URL parameters | not verified; passed on | verified (Mozilla roots); rejected |

## Differential test

`engines/tools-parity/rotate-data-key.ts`: 22 steps on synthetic databases (TOTP secrets and
channel configs under the old key, the new key, a third key, `v1.`, plain text, invalid UTF-8,
noisy base64, standard alphabet, a trailing `.part`, empty plaintext; flags, missing and invalid
keys, equal keys, report files, rotating back, and a trigger that fails the last unit then is
removed to resume). Tables are compared by what each value opens to, since every seal has a fresh
nonce.
