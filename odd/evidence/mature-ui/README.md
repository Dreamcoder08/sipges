# Mature UI verification evidence

Command, stdout, stderr and exit code are separate files sharing each prefix. These are local synthetic-data checks, not CI or production approval.

| Prefix | Exit | Observed result |
| --- | --- | --- |
| `verify` | 124 | 600-second timeout in API tests. Lint, format, boundaries, all package types, 10 E2E-support tests and 8 kernel tests passed before timeout. Full gate did not pass. |
| `e2e` | 124 | 600-second timeout. Web build passed; output includes a CSP failure in ontology-intelligence case 32. No final suite summary. |
| `csp-red` | 1 | New search regression detected the injected style element from Radix Overlay's scroll-lock helper. |
| `csp-green` | 1 | After removing injected styles, backdrop test detected inherited pointer-events:none under jsdom. |
| `csp-final` | 0 | Final pointer-events adjustment: 1 search test file, 4 tests passed. |
| `csp-e2e` | 0 | Rebuilt web and ran only ontology-intelligence in Chromium: 1 test passed with strict CSP. This build preceded the final pointer-events DOM-property adjustment. |
| `api-diagnostic` | 0 | One API domain file with filesystem module caching disabled: 2 tests passed. Does not prove the cause of the global timeout. |

The correction preserves the security policy: a CSS-styled presentational overlay replaces Radix Overlay's dynamically injected scroll-lock stylesheet; Radix Content retains focus trapping and dismissal. No `unsafe-inline` exception was added. The final DOM pointer-events adjustment was unit-tested, not browser-verified on an exact final rebuild.

Optional server PostgreSQL integration was skipped because no synthetic connection was supplied. Full workspace tests, final browser-build equivalence and the cause of the global runner timeout remain unverified. Do not read this evidence as a green global gate. No deployment or real-data operation occurred.
