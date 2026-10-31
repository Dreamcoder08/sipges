# T5 verification evidence

The functional verification is composed of serial component runs, not a relabelled successful monolithic gate.
The implementation is commit `6299b81fa6adfc1584a203aa4966dc04a6599b5d`.

| Component | Evidence | Result |
| --- | --- | --- |
| API, unchanged after this pass | `full-gate-api-web.log` | 691 passed, 14 skipped; the enclosing gate later failed in web |
| Kernel | `full-gate-api-web.log` | 8 passed |
| E2E support | `full-gate-api-web.log` | 10 passed |
| Full web, one worker | `web-serial.log`, exit file `0` | 65 files, 283 passed |
| Current lint, format, boundaries, types, web build | `remaining-checks-formatted.log`, exit file `0` | Passed; large-chunk warning retained |
| Hosting | `remaining-checks-formatted.log` | 4 files, 11 passed |
| Tooling, including both app-local runner regressions | `remaining-checks-formatted.log` | 9 passed |
| Final focused push check, parent execution | `push-final.log`, exit file `0` | 3 passed |
| Chromium desktop/mobile emulation | Earlier browser run in the feature log | 93 passed, 1 optional screenshot skipped |

Raw logs and exit files are local retained execution artifacts, not part of the code-review slice.
The feature document records the historical failures, commands, measurements and limitations:
[`integration-consolidation.md`](../../tasks/integration-consolidation.md).

Independent review found no severe static issue in S6/S7 and inspected component evidence.
Earlier independent runner regressions and hosting checks passed. The final independent push
execution was unavailable because the verifier's required system-temp isolation conflicted with
the parent's workspace confinement; the final 3-test run above was executed by the parent,
not independently. No result is invented for the unavailable command.

Real PostgreSQL integration was not run: no explicit synthetic connection was supplied.
No real-device push, production acceptance, WebKit or external-provider validation is claimed.
Native assessment remained unavailable because the provider rejected undeclared untracked files,
even for the requested committed range; no review lineage or native approval was created.
T6's HTTP benchmark `403` remains outside this work unit.
