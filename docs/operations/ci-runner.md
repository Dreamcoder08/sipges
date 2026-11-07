# Self-hosted CI runner

The repository is private on GitHub Free, so GitHub-hosted Actions minutes are limited (2,000 a month). When they
run out, GitHub refuses jobs with «recent account payments have failed or your spending limit needs to be
increased». CI and deploys can then run on a runner on the owner's machine instead.

## How the switch works

Most jobs read `runs-on` from the repository variable `SIPGES_RUNS_ON`. The exceptions stay on `ubuntu-latest`, so they still need hosted minutes: every `changes` job, on which the gated jobs depend, plus `image` in `go.yml`, `engines`, `fixtures` and `tools` in `rust.yml`, and `ops-review-materialize.yml`.

| `SIPGES_RUNS_ON` | Jobs run on |
| --- | --- |
| unset | GitHub-hosted (`ubuntu-latest`; the Python job keeps `ubuntu-24.04`) |
| `["self-hosted","sipges-local"]` | the runner started by `scripts/self-hosted-runner.sh` |

```sh
gh variable set SIPGES_RUNS_ON --body '["self-hosted","sipges-local"]'   # use the local runner
gh variable delete SIPGES_RUNS_ON                                        # back to GitHub-hosted
```

## Start and stop the runner

Needs Docker running (`sudo systemctl enable --now docker`) and the user in the `docker` group, plus `gh` signed in
with admin rights on the repository.

```sh
scripts/self-hosted-runner.sh start 2  # registers and starts two runners (default 1)
scripts/self-hosted-runner.sh status
scripts/self-hosted-runner.sh stop     # removes every runner container and unregisters them
```

The runner is the official `ghcr.io/actions/actions-runner` image plus Node 22 (`scripts/self-hosted-runner.Dockerfile`; Ubuntu, so `playwright install --with-deps`
works). It uses the host network and the host Docker daemon, so service containers (PostgreSQL) publish their ports on
`127.0.0.1` exactly as on GitHub-hosted runners.

## Caches on the self-hosted runner

Jobs on a self-hosted runner reuse work from earlier jobs instead of starting from zero. GitHub-hosted jobs are
unchanged (the workflow checks `runner.environment`).

| What | Where it lives | Effect on a warm runner |
| --- | --- | --- |
| pnpm store | `/home/runner/_work/_cache/pnpm-store` (`pnpm_config_store_dir`) | `pnpm install` links from the local store; `actions/setup-node` skips its GitHub cache download |
| Playwright browsers | `/home/runner/_work/_cache/ms-playwright` (`PLAYWRIGHT_BROWSERS_PATH`) | `playwright install <browser>` finds the browser and returns at once |
| Playwright system libraries (Chromium, WebKit) | baked into the image | the e2e job installs without `--with-deps`, so no apt work |

- Each cache sits in the runner's own volume (`sipges-runner-work`, `sipges-runner-2-work`), so two runners never
  write the same cache. The store shares the mount with the checkout, so pnpm hard-links instead of copying.
- The script reads the `@playwright/test` version from `apps/e2e/package.json` and passes it to the image build.
  After a Playwright upgrade, rebuild with `stop` and `start 2`: a stale image may miss a library the new browser needs.
- Runners started before this change keep working without the caches until they are restarted the same way.
- To clear the caches, `stop` and `docker volume rm sipges-runner-work sipges-runner-2-work`; the next `start`
  re-registers and downloads everything once.

## Limits

- Each runner runs one job at a time. Service containers publish a random host port, so several runners can share the
  machine; two is the sensible maximum with 7 GB of RAM.
- The machine has 7 GB of RAM: avoid running full suites locally while CI runs.
- The deploy job also runs here, so the Cloudflare deploy secrets reach this machine during a deploy. Only use a
  self-hosted runner on a private repository; never on a public one, where a fork's pull request could run code here.
- The machine must stay on for CI to run.
