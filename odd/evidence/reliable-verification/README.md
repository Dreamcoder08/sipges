# Reliable verification evidence

Local synthetic-data diagnostics only; neither the root check nor CI has passed as a result of this work. See the [verification guide](../../../docs/testing.md) and [earlier mature UI evidence](../mature-ui/README.md).

| Scope | Result | Evidence and limit |
| --- | --- | --- |
| Cached default API, two selected files | Passed: exit 0; 12 tests, about 14 s elapsed | [Command](api-default.command), [stdout](api-default.stdout), [stderr](api-default.stderr), [exit](api-default.exit). Domain cases: 2/10 ms; HTTP: first 3,880 ms, later 815–919 ms. Stderr and exit files exist but match repository ignore rules; include them explicitly with this evidence. |
| Earlier full root gate | Failed: timeout exit 124 at 600 s | [Earlier evidence](../mature-ui/README.md); full API cause unknown, no final API summary. |
| Final Dialog browser build/check | Passed: exit 0; about 13 s elapsed | Web build: 2.81 s; one Chromium search/360-degree test passed in 8.3 s, including browser hygiene under strict CSP. [Command](browser-final.command), [stdout](browser-final.stdout), [stderr](browser-final.stderr), [exit](browser-final.exit). Existing large-chunk warnings remain. |
| Optional server PostgreSQL integration | Skipped | No synthetic connection supplied in the earlier gate. |

The [before](browser-source-before.json) and [after](browser-source-after.json) snapshots match for 282 frontend, configuration and lock inputs, with aggregate SHA-256 `94d62506f1ba32facf8f5d0db9abf6daa2cb2a0f29ea1906253dd8c90a7945b5`. This closes the stale-build proof gap for the single browser flow, not the full browser suite. Browser stderr and exit files also match repository ignore rules and must be included explicitly with this evidence.

The cached selection passing disproves a universal startup or collection failure for those files, not a full-suite defect or a cache cause. The API's 106 files run with one worker; cumulative isolated fixture cost is a hypothesis, not a diagnosis. There is no evidence for changing runner configuration, fixture isolation, hashing, or timeouts. No full-gate pass is claimed.

For future runs capture command, stdout, stderr and exit code as separate artifacts, including empty streams. A partial progress log without a final result is incomplete; exit 124 is a failed timeout.
