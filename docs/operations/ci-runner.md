# Self-hosted CI runner

The repository is private on GitHub Free, so GitHub-hosted Actions minutes are limited (2,000 a month). When they
run out, GitHub refuses jobs with «recent account payments have failed or your spending limit needs to be
increased». CI and deploys can then run on a runner on the owner's machine instead.

## How the switch works

Every job reads `runs-on` from the repository variable `SIPGES_RUNS_ON`:

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
scripts/self-hosted-runner.sh start    # registers and starts the container
scripts/self-hosted-runner.sh status
scripts/self-hosted-runner.sh stop     # removes the container and unregisters the runner
```

The runner is the official `ghcr.io/actions/actions-runner` image (Ubuntu, so `playwright install --with-deps`
works). It uses the host network and the host Docker daemon, so service containers (PostgreSQL) publish their ports on
`127.0.0.1` exactly as on GitHub-hosted runners.

## Limits

- One runner runs one job at a time: the 8 CI jobs run one after another (slower than GitHub's parallel jobs).
- The machine has 7 GB of RAM: avoid running full suites locally while CI runs.
- The deploy job also runs here, so the Cloudflare deploy secrets reach this machine during a deploy. Only use a
  self-hosted runner on a private repository; never on a public one, where a fork's pull request could run code here.
- The machine must stay on for CI to run.
