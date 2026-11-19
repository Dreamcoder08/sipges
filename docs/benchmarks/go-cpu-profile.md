# Go API CPU profile at 1/4 vCPU

**Result: the Go API serves the four Wave A screens at 8 simultaneous screens with 3.1× the
throughput (90 → 284 req/s) and about a third of the latency (p95 of a whole screen 1,103 → 307 ms)
on a quarter of a CPU.** Responses are unchanged: parity 2,661/2,661 cases plus every secondary
suite, 0 differences.

[go-trial-results.md](../deployment/go-trial-results.md) found the `basic` instance (1/4 vCPU) at
100 % CPU at 8 screens and left the cause open. It was the IRSA: the Rust engine recomputed it
from all records on every `/system/irsa` call, about 60 % of the CPU with the Go code around it.
The rest was encoding/json parsing stored records and per-object maps.

Measured 2026-11-18 on a local machine (AMD Ryzen 5 4600H). Synthetic data only.

## Setup

| Item | Value |
| --- | --- |
| Data | `syntheticRecords(10)` of `apps/api/bench/synthetic.ts`: 4,840 records, 2,450 in the IRSA modules |
| Database | PostgreSQL 18.7 on loopback (`scripts/agents/test-pg.sh`), migrated by the TypeScript API, non-owner role |
| CPU limit | `systemd-run --user --scope -p CPUQuota=25%` and `GOMAXPROCS=1`: 1/4 of one core, like `basic` |
| Load | The `SCREENS` of `apps/api/bench/prod-screens.ts`, URL for URL: each of 8 screens fires every GET of a screen at once, waits for all, opens the next. 3 s warm-up, 20 s measured. The driver runs on other cores (`taskset`) |
| Rounds | Base, new and new+PGO interleaved, 3 rounds each; all requests answered 200 |

Base is `origin/main` (710d21f9) plus the off-by-default pprof server only.

## Where the CPU went (base)

CPU profile of 15 s under that load: 3.72 s of samples, 24.8 % of a core, so saturated.

| Cost | Share | What |
| --- | --- | --- |
| `runtime._ExternalCode` | 42 % | wazero's compiled Rust engine: the IRSA, about 20 ms per call on a full core, 80 ms at 1/4 |
| `indicators Service.Irsa` (Go side) | 19 % | reading 2,450 payloads, `Records.JSON` (a `json.Encoder` per record id), a second copy into the request |
| `records summary` | 14 % | `encoding/json.Decoder.Token` over the `json_agg` page, a map per object |
| `records list` | 10 % | the same parse per payload, then `Clone` and re-encode per row |
| GC, syscalls, the rest | 15 % | |

## Fixes

1. **Memoized indicators engine** (`internal/platform/engines/memo.go`). The engine's answer is a
   function of the request bytes alone: the module imports no clock (a test fails if its imports
   change), wazero gives every instance the same deterministic `random_get` source and an empty
   environment. So a request it already answered is answered again from memory, keyed by SHA-256
   of the request: bounded LRU (64 answers, 16 MiB), one computation per concurrent key, failures
   never kept. The request still reads the current records on every call, so a changed record is a
   new key: nothing can be stale.
2. **The IRSA request is written once** into a pooled buffer, with record ids quoted directly
   instead of through `json.Encoder`, and pgx's per-row `[]byte` kept instead of copied.
3. **Stored JSON parsed without encoding/json** (`ParseStored`): the existing hand-written body
   parser, which takes unescaped strings as substrings. Text the two parsers could read differently
   (invalid UTF-8, surrogate escapes) or that the fast one refuses goes through `Parse`; a fuzz test
   holds `ParseStored` equal to `Parse`.
4. **`Object` without a map**: keys and values in parallel slices, an index map only past 16 keys;
   `arrayIndex` returns before `ParseUint` (and its error allocation) for keys that cannot be indexes.
5. **Encoding**: strings that need no escape are copied whole; the list writes
   `{...payload, _id, _updated_at}` without cloning each payload.
6. The metrics route label `strings.Replacer` is built once instead of per request.

## Benchmarks

`go test -bench` on one pinned core (`-test.cpu 1`), base and new test binaries alternated 10
times; `benchstat` of the two:

```
              │   old.txt    │               new.txt                │
              │    sec/op    │    sec/op     vs base                │
SummaryRows      4.057m ± 4%   2.010m ±  1%  -50.46% (p=0.000 n=10)
PayloadObject   2017.3µ ± 5%   672.1µ ±  3%  -66.68% (p=0.000 n=10)
ListJSON         5.735m ± 3%   1.732m ±  4%  -69.79% (p=0.000 n=10)
RecordsJSON     4298.9µ ± 5%   375.4µ ± 17%  -91.27% (p=0.000 n=10)
Irsa             22.10m ± 1%   17.64m ±  2%  -20.18% (p=0.000 n=10)
IrsaMemo                       749.9µ ±  1%
geomean          5.368m        1.505m        -67.77%

              │    old.txt    │               new.txt                │
              │     B/op      │     B/op      vs base                │
SummaryRows      2.257Mi ± 0%   1.052Mi ± 0%  -53.37% (p=0.000 n=10)
PayloadObject   1265.5Ki ± 0%   359.4Ki ± 0%  -71.60% (p=0.000 n=10)
ListJSON         3.148Mi ± 0%   1.916Mi ± 0%  -39.14% (p=0.000 n=10)
RecordsJSON      5.371Mi ± 0%   1.133Mi ± 0%  -78.91% (p=0.000 n=10)
Irsa            7103.0Ki ± 0%   472.9Ki ± 1%  -93.34% (p=0.000 n=10)
IrsaMemo                        44.16Ki ± 0%
geomean          3.184Mi        513.9Ki       -74.25%

              │    old.txt     │               new.txt                │
              │   allocs/op    │  allocs/op   vs base                 │
SummaryRows        50.84k ± 0%   26.01k ± 0%   -48.84% (p=0.000 n=10)
PayloadObject     20.585k ± 0%   9.250k ± 0%   -55.06% (p=0.000 n=10)
ListJSON           8.531k ± 0%   2.030k ± 0%   -76.20% (p=0.000 n=10)
RecordsJSON     27006.000 ± 0%    1.000 ± 0%  -100.00% (p=0.000 n=10)
Irsa             27030.00 ± 0%    18.00 ± 6%   -99.93% (p=0.000 n=10)
IrsaMemo                          2.000 ± 0%
geomean            23.06k         161.3        -98.32%
```

`Irsa` is a cache miss (the Rust engine runs); `IrsaMemo` is the same call with unchanged records,
what every screen after the first pays. The benchmarks live next to the code
(`internal/records/{infrastructure,http}`, `internal/indicators/{domain,application}`), on
`internal/platform/synthetic`.

## End to end at 8 screens, 1/4 vCPU

Requests per second over the three interleaved rounds:

| Build | Round 1 | Round 2 | Round 3 |
| --- | --- | --- | --- |
| Base | 90.7 | 89.5 | 91.8 |
| New | 281.3 | 283.1 | 288.9 |
| New + PGO | 278.4 | 286.1 | 290.1 |
| New, memo off (every IRSA a miss) | 127.0 | 129.8 | |

Whole screen, p50/p95 in ms, round 2:

| Screen | Base | New |
| --- | --- | --- |
| Inicio | 794/1089 | 208/388 |
| Registros | 518/890 | 201/299 |
| Registros lista | 497/786 | 197/290 |
| IRSA | 803/1272 | 203/308 |
| All screens | 615/1103 | 202/307 |

Without the memo the parsing and encoding work alone gives +42 %; right after a record changes,
the first IRSA of each project is such a miss, then the screens hit again.

## Profile-Guided Optimization: not adopted

A 40 s CPU profile of the new build under this load, as `cmd/api/default.pgo`, gave 278–290 req/s
against 281–289 without it: inside the noise. The remaining CPU is syscalls (16 %), copying and GC,
which inlining does not reach. Not committed; worth repeating if the profile changes shape.

## Not changed, worth a look

- **GC**: about 10 % of the remaining CPU. `GOGC` above 100 under the existing `GOMEMLIMIT=800MiB`
  (peak use was 108 MiB) would trade memory for CPU; it is deployment configuration.
- **The IRSA still reads every record per call** to build its key (about 1 MB from PostgreSQL). A
  per-tenant change counter would skip that read, but needs a migration.
- These are local numbers on loopback; on `basic` the database is Neon over the network, so the
  absolute latencies differ. The CPU per request is what moves.

## Profiling a running API

`SIPGES_GO_PPROF_ADDR=127.0.0.1:6061` starts `net/http/pprof` on its own listener and mux. It is
off unless set, and the API refuses to start with an address that is not loopback (`0.0.0.0`, `:6061`,
a public IP or host name). Never set it on a deployed instance.

```sh
SIPGES_GO_PPROF_ADDR=127.0.0.1:6061 GOMAXPROCS=1 \
  systemd-run --user --scope -p CPUQuota=25% -- ./api-go &
curl -o cpu.pprof 'http://127.0.0.1:6061/debug/pprof/profile?seconds=15'   # under load
go tool pprof -top ./api-go cpu.pprof
```

Interleaved benchmarks: build each side's test binary with `go test -c`, run them alternately
pinned to one core with `-test.cpu 1 -test.count 1`, ten times, then `benchstat old.txt new.txt`.
