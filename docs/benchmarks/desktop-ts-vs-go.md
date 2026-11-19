# Desktop stack: TypeScript + PGlite vs Go + PostgreSQL 18 (go-rust-stack T72)

The client's laptop runs the TypeScript API (`apps/api/src/main.ts`) on PGlite, PostgreSQL compiled to
WebAssembly inside the Node process. At the visit it moves to the Go launcher (`sipges-desktop`), which runs
the Go API against a bundled PostgreSQL 18 ([ADR 0036](../adr/0036-desktop-go-with-bundled-postgresql.md)).
This page measures both stacks on the same machine with the same synthetic data, so the move rests on
measured numbers.

**Result (Linux, 2026-11-18):** on every measure except disk, Go + PostgreSQL 18 beats TypeScript + PGlite.
At 10× data it starts in half the time and serves about 5× the screen requests per second at 4 and 8
concurrent screens. Its median request latency is 15–22× lower, its writes are 5–6× faster, and the whole
stack uses about half the memory. The data folder is 13 % larger at 10×; all of that difference is
PostgreSQL's preallocated WAL. No request failed in any run.

## Method

- Tool: [`deploy/desktop/bench/desktop-bench.mjs`](../../deploy/desktop/bench/desktop-bench.mjs)
  (`pnpm bench:desktop`), pure parts tested in `desktop-bench.test.mjs`.
- Stacks, as the desktop starts them:
  - **TypeScript + PGlite**: `node apps/api/src/main.ts` with the managed launcher's environment
    (`SIPGES_PGLITE_DIR`, uploads, data key, administrator password, loopback, plain-HTTP cookies).
  - **Go + PostgreSQL 18**: the real Go launcher `sipges-desktop --state … --pg-bin … --api … --migrations …`.
    On each start it starts PostgreSQL through `pg_ctl`, checks roles, runs `api migrate` (a no-op here) and
    serves the Go API.
  - Both stacks run with `SIPGES_REQUIRE_MFA=0`, as `apps/parity` does, so the runs measure the routes and not
    a second factor. Every other setting is the desktop default, including the access log.
- Data: `apps/api/bench/synthetic.ts` (seed 42). 1× is the legacy installation's record counts plus 20 per
  RC 1.7 module: 484 records, the laptop-like size. 10× is 4,840 records. One state folder is prepared per
  stack and size. A first start applies the migrations and creates the administrator. The same `INSERT … FROM
  jsonb_to_recordset` that `bench/run.ts` uses then loads the records into `module_records` for project
  `SIPGES/PRJ-SECHURA`, followed by `ANALYZE` and `CHECKPOINT`. PGlite gets the rows in-process with the API
  stopped; PostgreSQL gets them as its superuser while the launcher runs.
- Each run copies the prepared folder, so every run starts from the same data:
  1. **Start**: from spawning the process to `GET /health/ready` answering 200. The page cache is warm (the
     folder was just copied), so this is a process start, not a cold boot of the computer.
  2. **Screens**: the four screens of `bench:prod-screens` (`SCREENS` in `apps/api/bench/prod-screens.ts`:
     Inicio, Registros, Registros lista, IRSA) at 1, 4 and 8 concurrent screens, 10 s each. Each screen fires
     its GETs together, as `apps/web` does. Request p50/p95 are nearest-rank values over every successful
     request of the step; requests/s is requests ÷ 10 s.
  3. **Writes**: 40 sequential `POST /api/eventos` creates, each followed by a `PUT /api/eventos/<id>`
     update, as the administrator. Every write was answered 2xx.
  4. **Memory**: the API process's peak RSS (`VmHWM`). PostgreSQL and the total are the peak of the
     proportional set size (Pss) summed per role, sampled every 500 ms. Pss counts a page shared between
     PostgreSQL processes once. For TypeScript, PGlite lives inside the API process, so it has no separate
     row.
  5. **Disk**: apparent size of every file in the data folder (`pglite` or `pg18`), after seeding and after
     the run.
- Three repetitions per stack and size. The stack that runs first alternates on every repetition. A cell
  shows the median of the three runs. When one run is more than 25 % away from that median, the cell lists
  all three in run order. Such outliers are reported, never dropped.
- The load client runs on the same machine and shares its CPU, the same for both stacks.

Machine: AMD Ryzen 5 4600H (6 cores, 12 threads), 7 GiB RAM, Linux 6.18 (Arch), Node 26.13.1,
PostgreSQL 18.7 from the distribution (`/usr/bin`), Go 1.27.4. The laptop's PGlite is 0.5.15, the version
`apps/api` pins. One run took 9 minutes.

```sh
pnpm bench:desktop -- --pg-bin /usr/bin --out result.json   # defaults: --sizes 1,10 --reps 3 --steps 1,4,8
```

## Results

Cells hold the median of 3 runs. A cell that lists three values in parentheses has an outlier among them.

### 1× (484 records)

| Metric                                  | TypeScript + PGlite        | Go + PostgreSQL 18      | Go ÷ TS |
| --------------------------------------- | -------------------------: | ----------------------: | ------: |
| Start to /health/ready (ms)             | 2562 (2562 / 3591 / 2257)  | 1386 (991 / 1386 / 1386) | 0.54   |
| 1 screen: requests/s                    | 164                        | 646 (647 / 342 / 646)   | 3.94    |
| 1 screen: request p50 / p95 (ms)        | 18 / 60                    | 4 / 13                  | 0.22    |
| 4 screens: requests/s                   | 229                        | 1234                    | 5.39    |
| 4 screens: request p50 / p95 (ms)       | 81 / 229                   | 11 / 28                 | 0.12–0.14 |
| 8 screens: requests/s                   | 190 (190 / 262 / 167)      | 1108                    | 5.83    |
| 8 screens: request p50 / p95 (ms)       | 198 / 568 (568 / 402 / 846) | 29 / 66               | 0.12–0.15 |
| Error rate (every step)                 | 0                          | 0                       | –       |
| Create record p50 / p95 (ms)            | 27.1 / 64.8                | 6.4 / 16.3              | 0.24–0.25 |
| Update record p50 / p95 (ms)            | 29.2 / 48.7                | 6.8 / 14.3              | 0.23–0.29 |
| API process peak RSS (MB)               | 453                        | 85                      | 0.19    |
| PostgreSQL processes peak, Pss (MB)     | – (inside the API)         | 68                      | –       |
| All processes peak, Pss (MB)            | 439                        | 140                     | 0.32    |
| Data folder after seeding (MB)          | 41.3                       | 66.0, of which pg_wal 32 | 1.60   |
| Data folder after the run (MB)          | 41.7                       | 66.3                    | 1.59    |

### 10× (4,840 records)

| Metric                                  | TypeScript + PGlite        | Go + PostgreSQL 18      | Go ÷ TS |
| --------------------------------------- | -------------------------: | ----------------------: | ------: |
| Start to /health/ready (ms)             | 1927                       | 940 (1234 / 882 / 940)  | 0.49    |
| 1 screen: requests/s                    | 100                        | 223                     | 2.23    |
| 1 screen: request p50 / p95 (ms)        | 15 / 111                   | 3 / 40                  | 0.20–0.36 |
| 4 screens: requests/s                   | 104 (99 / 104 / 136)       | 544                     | 5.23    |
| 4 screens: request p50 / p95 (ms)       | 153 / 559                  | 7 / 62                  | 0.05–0.11 |
| 8 screens: requests/s                   | 133 (88 / 139 / 133)       | 659                     | 4.95    |
| 8 screens: request p50 / p95 (ms)       | 248 / 565 (1203 / 565 / 535) | 16 / 104             | 0.06–0.18 |
| Error rate (every step)                 | 0                          | 0                       | –       |
| Create record p50 / p95 (ms)            | 28.8 / 97.3 (143.9 / 36.8 / 97.3) | 4.7 / 7.5 (6.8 / 7.5 / 21.5) | 0.08–0.16 |
| Update record p50 / p95 (ms)            | 27.5 / 55.9 (74.1 / 28.7 / 55.9) | 4.8 / 7.5        | 0.13–0.17 |
| API process peak RSS (MB)               | 477                        | 190                     | 0.40    |
| PostgreSQL processes peak, Pss (MB)     | – (inside the API)         | 87                      | –       |
| All processes peak, Pss (MB)            | 467                        | 264                     | 0.57    |
| Data folder after seeding (MB)          | 67.4                       | 76.1, of which pg_wal 32 | 1.13   |
| Data folder after the run (MB)          | 67.7                       | 76.8                    | 1.13    |

## Reading the numbers

- **Throughput and latency.** PGlite has one single-user backend inside the Node process, so every query
  waits its turn on one thread. TypeScript's requests/s barely grows from 1 to 8 screens (164 → 190 at 1×,
  100 → 133 at 10×), and latency grows with the queue: p50 is 198–248 ms at 8 screens. The Go API runs a
  connection pool against a multi-process server. It reaches about 5× the requests/s with p50 at 16–29 ms,
  and at 4 and 8 screens its p95 stays below TypeScript's p50.
- **The first screen alone** (1 screen) is where a single user feels it: requests take 3–4 ms on Go and
  15–18 ms on TypeScript (p50).
- **Writes** run 4–6× faster at p50. The p95 gap widens at 10× (7.5 vs 97.3 ms).
- **Memory.** The TypeScript process carries Node, the API and the PGlite WebAssembly heap: about 450–480 MB
  at both sizes. Go + PostgreSQL together peak at 140 MB (1×) and 264 MB (10×). Go's peak grows with data
  because a 10× response is held in memory while it is written.
- **Disk.** Without its 32 MB of preallocated WAL segments, PostgreSQL's data is smaller than PGlite's at 1×
  (34 vs 41 MB) and at 10× (44 vs 67 MB). The WAL size is bounded by `max_wal_size`, not by data volume.
- **Start.** Go is ready in about 1 s, including starting PostgreSQL. TypeScript takes about 2 s. Run-to-run
  spread is large on this laptop (2.2–3.6 s for TypeScript at 1×), so the order of magnitude matters more
  than the exact figure. 10× started faster than 1× on both stacks: start time does not depend on these
  data sizes.
- **Outliers.** They appear on both stacks and do not change the order of any comparison. The worst is one
  TypeScript run at 10× with p95 of 1203 ms at 8 screens.

## Limits

- **This is Linux, not the client's Windows laptop.** Linux cannot show:
  - Windows process creation and Defender's on-access scanning of `postgres.exe`, `pg_wal` and the PGlite
    files: both start times and every write may be slower there;
  - NTFS and the laptop's disk, which set the cost of every fsync PostgreSQL makes on commit (PGlite's
    durability path differs);
  - the EDB Windows build of PostgreSQL 18 that the installer ships (here: the distribution's 18.7 build);
  - Windows memory accounting (working set, not Pss) and the laptop's own CPU, RAM and power plan.

  The ratios between the stacks are more likely to carry over than the absolute numbers, but even the
  ratios are not proven for Windows. The manual
  [`desktop-bench.yml`](../../.github/workflows/desktop-bench.yml) workflow runs the same benchmark on
  `windows-latest` with the pinned PostgreSQL 18 bundle and uploads the JSON. A shared runner is noisy,
  and on Windows memory is one snapshot of peak working sets taken at the end of the run (a shared page
  counts once per process, so the PostgreSQL sum overstates). Only a run on the laptop itself measures
  the laptop.
- One machine and three repetitions: the medians are indicative, not statistically tight. The load client
  shares the CPU with the server.
- Synthetic data and one project. The screens read at most 500 records per list, as `apps/web` does, so
  10× lists are full pages. The data move itself (`pglite-to-postgres.mjs`) is not measured here.
- MFA is off for both stacks. Login cost is not part of any number.
