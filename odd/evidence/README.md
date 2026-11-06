# Evidence

Each folder holds the output of a past verification run. On 2026-11-06 the old product name was replaced with
SIPGES in this captured output (T59 of [go-rust-stack](../tasks/go-rust-stack.md)), so names and paths in these
files may differ from what the run printed. The captured text as produced is at commit `ab9d2c1f`.

No test, script or hash reads these files. The old name stays only where a recorded hash or a database object fixes it:

- `production-candidate/`: the anonymous response body, because the recorded SHA-256 and byte length cover it.
- `full-verification/browser-source-before.json`: a source path that feeds `aggregate_sha256`.
- `full-verification/api-batch-3-run.stdout`: the PostgreSQL role `mascli_tenant` in an error message.
- `sipges-4-only/README.md`: the branch name and the stored value of that time.
