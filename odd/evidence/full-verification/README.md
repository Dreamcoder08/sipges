# Full local verification

**Status: everything passes except the supplemental WebKit suite, which is blocked by the host environment.**
Every stage of `pnpm verify`, the full default browser suite and the Python reference passed. The nine WebKit tests never launched a browser because this Arch host lacks WebKit's system libraries.

## Observed results

| Stage | Result | Evidence |
| --- | --- | --- |
| API | 106 files exactly once; 736 passed, 0 failed, 1 optional PostGIS skip | `api-runtime-coverage.json`, `api-batch-*-result.json` |
| Lint and format | Exit 0 | `lint.*` |
| Dependency boundaries | Exit 0 | `boundaries.*` |
| Typecheck | Exit 0 | `typecheck.*` |
| Other package tests | 320 passed, exit 0 | `non-api-tests.*` |
| Tooling tests | 9 passed, exit 0 | `tooling-tests.*` |
| Python reference (isolated 3.12.8) | 40 passed, 0 failed, 47 deprecation warnings | `python-isolated-summary.json`, `python-*.*` |
| Web build | Exit 0 | `web-build.*` |
| Chromium/mobile browser | 94/94 reported; 93 passed, 0 failed, 0 flaky, 1 opt-in skip | `browser-default-summary.json` |
| Supplemental WebKit | 9 failed at browser launch: missing host libraries | `browser-webkit-run.*` |

This is **composed stage coverage**, not one recorded invocation of `pnpm verify` or CI. Combined with the web build, it covers every command `pnpm verify` runs.

## What the timeouts were

Historical runs of `pnpm verify` and `pnpm e2e` stopped at 600 seconds with exit 124. That limit was imposed on the command from outside, not configured by the repository. Measured durations explain the timeouts without a defect:

- API alone takes 9 minutes 19 seconds (four batches: 89, 139, 151 and 178 seconds).
- The default browser suite takes 7 minutes 40 seconds.

CI allows 20 minutes per job. No test or hook limit was changed. The longer external caps used here (1,200 seconds for the browser suite) match the CI job budget.

## API coverage and isolation

- `api-list-all.stdout` holds the 106-file inventory. `api-batch-manifest.json` splits it 27/27/26/26 through explicit public CLI file filters.
- `api-batch-safe-coverage.json` proves the four discovered selections equal the inventory, with no missing files, extras or overlaps. Each runtime JSON report matches its batch.
- Test and hook limits stayed at 20 seconds, with one worker and file isolation.
- Real PostgreSQL integration ran against an owned, temporary PostgreSQL 18.6 cluster bound to loopback, with ephemeral credentials that were never recorded. `postgres-lifecycle.json` confirms shutdown and removal.
- The only skip is the PostGIS/geodesic comparison in `test/geography/influence.test.ts`: the local server has `pg_trgm` but no PostGIS. CI's PostGIS image covers it.
- All 418 API inputs match the pre-run hash (`api-source-after.json`).

## Discovery incident, recovered

The installed `vitest list --shard=N/4` returned all 106 files for every shard, so it could not prove disjoint selections. That negative evidence is kept.

A later command put the optional `--json` flag before the file filters. Vitest took the first test path as its output file and overwrote it. The run stopped at once, and only that previously clean file was restored from `HEAD`; `incident-recovery.json` proves the bytes match. The corrected command puts file filters before a final bare `--json`.

**Lesson:** a flag with an optional value can swallow the next argument. Put positional arguments first, or give the flag its value with `=`.

## Python reference environment

The first attempt used system Python 3.14.8, pytest 9.2 and a newer Starlette. It failed before collection because that Starlette requires `httpx2`. This was an environment mismatch, not an application regression.

With consent, an isolated environment was built under `node_modules/.cache/mascli-python-reference` with uv, Python 3.12.8 and only `requirements-test.txt`. The freeze confirms pytest 8.3.5 and httpx 0.28.1; all 40 tests pass.

**Follow-up, not fixed:** `requirements.txt` sets only lower bounds. The resolved Starlette 1.3.1 already deprecates `httpx`, so the frozen reference suite will break when that support is removed. The frozen reference was not modified.

## Browser suites

- Web build passed. The default config ran all 94 discovered tests in one worker, with a 60-second per-test limit and no retries.
- The single skip is `screenshots.mobile.spec.ts` "capture the mobile shell". It is an opt-in capture gated on `MASCLI_E2E_SCREENSHOT_DIR`, not a behaviour check.
- All 644 source, configuration and lock inputs are unchanged (`browser-source-after.json`).
- Pinned WebKit installed without `--with-deps` or `sudo`. All nine tests then failed at `browserType.launch`: "Host system is missing dependencies to run browsers" (`libicu74`, `libxml2`, `libflite1`). No page was opened, so this says nothing about the application on WebKit.
- The Docker daemon, which could provide the official Playwright image, is not running, and starting it requires `sudo`. System packages were deliberately not installed.

## Remaining

- WebKit coverage needs a host with WebKit's libraries: CI (`playwright install --with-deps`) or a running Docker daemon.
- PostGIS distance comparison needs a PostGIS-enabled server: CI or a local PostGIS image.

## Scope safeguards

This unit made no product code, dependency, layer, test-limit or security changes. It involved no deployment, real data, push or PR. Unrelated Cloudflare changes remain outside this work unit.
