# SIPGES production candidate — first consolidation slice

Prepare an evidence-backed candidate, beginning with the measured dashboard overfetch.
Week/month are planning horizons, not guaranteed delivery dates or authorization to deploy.
Base: `4a4b5f0`; branch: `feat/production-candidate-dashboard`.

## Specs

- S1 — Original authorization: «has lo que haria gentleman , usa ODD y mas para avanzar de forma autonoma objetivo que mascli ssea funcional , listo para produccion y mas , eliminar redundancia , legacy , objetivo estar en la vanguardia como los mejores del mundo en esta semana o mes».
- S2 — Execution direction: «usa ODD y mas para avanzar de forma autonoma».
- S3 — Functional and readiness objective: «objetivo que mascli ssea funcional , listo para produccion y mas».
- S4 — Consolidation objective: «eliminar redundancia , legacy».
- S5 — Planning horizon: «objetivo estar en la vanguardia como los mejores del mundo en esta semana o mes».

## Tasks

- T1 [x] S1,S2,S3,S5 — Reconcile inherited readiness gates, define bounded milestones and record this specification/memory before source edits; route: read-only explore + parent spot check; commit: pending first slice
- T2 [x] S1,S2,S3,S4 — Exclusive dashboard projection implemented; focused22/22, types/lint/format pass; reader comparison preserves191-byte summary and reduces returned-record JSON89.93%; wider candidate proof remains T4; route: scoped worker (context backstop) + parent readback; commit: `2ba2b5a`
- T4 [x] S1,S3 — Local affected gates passed: lint/format/boundaries/workspace types, API696passed14skipped, HTTP differential16/16 and independent static security review; operational PostgreSQL/production proof remains explicitly unmet; route: serial checks + independent verifier; commit: `2ba2b5a` (with T2)
- T3 [x] S1,S3,S4,S5 — Readiness separates the dated demo (MFA exception only for that demo, public CRUD/Blob/PDF/DOCX smoke still pending) from the local candidate and institutional gates; access-log text matches `SIPGES_ACCESS_LOG`; reference/migration tools kept; route: parent draft + scoped worker + parent readback; commit: documentation slice after `2ba2b5a`
- T5 [x] S1,S2,S3,S5 — Evidence README records gates, review scope, measurement denominators and the exact operator inputs; no production gate certified; route: inline closure + Engram sync; commit: same documentation slice

## First-slice acceptance and boundaries

The following translate the objective into a bounded engineering unit; they are not claims
that the user specified additional product behavior.

- Dashboard HTTP status, response structure, counters, level fallback/coercion and current
  ordering remain equivalent. Preserve `dashboardSummary`, `pyStr` and `pyTruthy` behavior.
- Use a dedicated dashboard projection/reader; do not narrow the generic reader used by
  other analysis/report routes. Preserve absent/null/non-string payload handling.
- Preserve `withTenant`, the non-owner tenant role, forced-RLS checks, project scoping and
  record-clearance filtering. No shortcut around MFA, grants or restricted records.
- Demonstrate reduced data materialization on the same synthetic workload; report latency
  samples separately from deterministic payload reduction. No performance claim from test
  presence or a single timing, and no comparison against different historical hardware.
- Compare existing sibling analytics through public HTTP. Tests do not read git history;
  a transient differential experiment may use an isolated copy of the base.
- No new framework, database, runtime dependency, cloud migration, public endpoint or
  externally consumed configuration contract is required for this unit.
- `reference/python` remains the behavior/parity reference, not a deployed runtime. Removal
  requires separate proof that no reference/fixture contract is lost. Real-data migration
  tooling is not redundant merely because the TypeScript runtime exists.
- Do not sweep stored objects, rewrite records, deploy, publish, contact production or use
  real credentials/data. Preserve unrelated `docs/agents/gentle-ai.md`, `.pi/` and raw logs.

## Evidence entering this slice

[Integration consolidation](integration-consolidation.md) is closed 7/7 for its local audit,
not a declaration of institutional production readiness. T5's staged API/web/browser proof
and [T6's benchmark](../evidence/t6-benchmark/README.md) remain attributed to their candidates.

A later read-only profile used isolated PGlite, 4,840 synthetic records, three warm-ups and
10 samples per scenario. Dashboard read 3,580 full rows for a 191-byte response: reader p95
63.83 ms versus prefetched summary calculation 0.04 ms and JSON encoding 0.01 ms.
IRSA reader p95 was 53.63 ms versus calculation 9.13 ms. Situaciones retained material
processing cost after prefetch (77.38 ms p95). These are not PostgreSQL-server or load tests.
The next implementation therefore targets dashboard input, not a global technology rewrite.

## Readiness ownership and milestones

| Gate | Current evidence | Owner / next proof |
| --- | --- | --- |
| Local candidate correctness | Current API696passed14skipped; lint/format/boundaries/workspace types; seven exact public HTTP responses and independent static security review | Local scope verified; not an aggregate pnpm verify, new browser run, server-PostgreSQL or production acceptance claim |
| Least-privilege PostgreSQL | Existing SQL/RLS contracts and historical integration documentation | Operator supplies an explicitly synthetic authorized connection; prove current adapter/role behavior before institutional sign-off |
| Public demo | Dated deployment documentation records some synthetic public checks | Historical only; no fresh public request or credential use in this slice |
| Institutional identity/storage | Secure defaults and documented deployment checklist | Operator-owned environment/configuration evidence; demo MFA exception is not an institutional approval |
| Restore and coordinated DB/object backup | Procedure exists; successful current restore drill not established | Authorized disposable restore environment, key/bucket scope and observed drill |
| Real-device/provider/source acceptance | Inherited GEOCATMIN, push/device and original-source tasks remain open | Their owners provide access/acceptance; do not close by code presence |
| Delivery and activation | Local branch only; remote PR/CI/deployed provenance not freshly checked | Separate delivery/activation decision; no publishing inferred |

**One-week horizon:** complete the first measured slice and the executable local candidate
gates, reconcile dated documentation and report operator blockers precisely. Not a promise
of production acceptance in seven days.

**One-month horizon:** contingent on operator decisions and suitable environments, establish
current real-PostgreSQL/restore/monitoring/external acceptance proof. Do not promise a date for
unavailable providers, original documents, hardware or real-data approval.

Existing owners remain authoritative:
[data quality](../tasks/data-quality-relationships-followup.md),
[Situaciones](sipges-4-situations.md),
[media monitoring](media-monitoring-project-phase.md), and
[territorial intelligence](../tasks/territorial-intelligence-alerts.md).
No task there is closed by this programme without its required evidence.

## Risk and review boundaries

T2 is security-sensitive (item 2): it changes SQL reading under tenant/clearance controls.
Keep it in its own reviewable commit with tests and behavior documentation. Check shared
composition/service contracts for unrequested changes (item 3 if one is introduced).
The native review candidate is the work unit, never the accumulated T5/T6 branch.
Current boundary is `4a4b5f0`; subsequent documentation is a separate slice. Aim for about
400 authored changed lines; report an overage rather than compressing tests or evidence.

## Log

- L1 — Original request verbatim: «has lo que haria gentleman , usa ODD y mas para avanzar de forma autonoma objetivo que mascli ssea funcional , listo para produccion y mas , eliminar redundancia , legacy , objetivo estar en la vanguardia como los mejores del mundo en esta semana o mes».
- L2 — Authorization interpretation: autonomous evidence-backed implementation is now in scope, including the previously proposed dashboard improvement. No implicit Cloudflare/D1 migration, deployment, publication, real-data access or destructive deletion. Week/month are conditional planning windows.
- L3 — Read-only exploration mvo66a2r-3-5xnx reconciled inherited open tasks and readiness gates. Parent read deployment/readiness.md: the newer synthetic-demo exception and older MFA/CRUD prose coexist; no fresh live deployment claim follows. Reference Python is outside the runtime and remains a parity contract. The proposed object-sweeping work was not selected: measured dashboard input is the lower-risk first unit, while stored-object deletion needs a separately bounded decision.
- L4 — Branch feat/production-candidate-dashboard created from4a4b5f0. Unrelated gentle-ai documentation change, .pi and raw T5/T6 logs preserved. Specification and Engram mirror precede the first source edit. Initial investigation/profile introduced no source changes.
- L5 — Worker mvo6ggf8-4-rgkv implemented only six allowed surfaces. Focused RED2failed/5passed includes meaningful overfetch assertion and a fixture setup failure; an intermediate fixture grant ambiguity failed1/6passed. Corrected GREEN7/7 then preserved/refactor22/22 across5files21.08s. APItypes/lint/format pass, Node localStorage warning retained. HTTP assertions preserve counters/fallbacks/coercions, complete sibling input, tenant/clearance behavior and unchanged public records/counters after exact403 rejection. Parent read source/tests/diff and checked whitespace; no broader candidate pass claimed yet.
- L6 — Worker transient comparison: same migrated in-memory PGlite, synthetic10x4840records,3warmups10interleaved samples/readers. Both3580rows, recordsJSON1684873→169590B(-89.93%), summariesbyte-identical191B; readerp50 49.24→29.59ms,p95 58.68→34.53ms. This is worker-reported evidence, not parent base-commit HTTP comparison or PostgreSQL-server/load proof. ASSESS escalation item2 requires independent verification; native assessment unassessable due undeclared untracked files, no authority/reviewDue/approval established. T4 is ordered before T3 to verify and commit the security-sensitive unit independently of documentation cleanup.
- L7 — Independent verifier mvo6yuz6-6-pjzz read the whole specification, diff, tenant transaction, policies, semantics and tests: no static security/contract blocker. Classification is the stored marking column checked by sipges_can_see, not the projected payload; the SELECT-list alias does not replace original-row RLS. Raw JSON, forced-RLS refusal, parameterization/order, optional-reader fallback and full sibling readers are preserved. Report is static only: no fresh independent tests, scratch or database setup. HTTP differential and broad gates remain pending T4; no approval by test presence or native authority. Optional tie-order/routing assertions were suggestions, not required corrections, and were not silently added.
- L8 — Runtime evidence worker mvo6xvnf-5-1but finished; parent read comparison.json, README and the three successful exit0 records. Base4a4b5f0/current seven GET tuples match exact status/content-type/bytes/SHA256 without body normalization; anonymous401 and denied403 exact bodies, public dashboard/event-list unchanged after rejection. Compare16/16PASS. SQL row-array JSON1792483→277200B(-84.54%) for3580rows/one query each; this differs from the downstream domain-record89.93% denominator. HTTPdashboard191Bunchanged,p50 49.61→31.66ms,p95 59.86→51.09ms(3warmups10serialsamples/basefirst,diagnostic only). Two transient harness failures retained (wrong anonymous-message expectation; regex omitted public schema), corrected without candidate-source changes. Parent removed only owned canonical scratch, preserving JSON/logs/failures and programme hashes in the evidence README.
- L9 — Parent broad-gates job2 launched only after comparison runtime ended: clean environment pnpm lint, architecture boundaries, all workspace typechecks, then full API with app-local Vitest --no-fs-module-cache. Separate stdout/stderr/exit files under odd/evidence/production-candidate. Result was pending at launch. Real PostgreSQL optional integration remains unexecuted without an explicitly authorized synthetic connection.
- L10 — Parent read job2 exit0 and full stdout/stderr: lint/format OK; boundaries737modules2177dependencies; six workspace typechecks complete; API99files passed5skipped,696tests passed14skipped,514.37s(totaljob9m11s). Retained localStorage/PDF indexing warnings. T4 local affected checks complete: no new browser run (no UI/response contract change), aggregate pnpm verify or PostgreSQL-server check claimed. Rollback boundary is the dashboard adapter, optional service seam, compose wiring, regression tests and benchmark notes only; generic/domain readers and policies remain unchanged. Source plus specification is one approximately400-authored-line security unit; generated evidence/memory is counted separately. Documentation/readiness cleanup follows separately.
- L11 — Security slice committed as `2ba2b5a` (4a4b5f0→2ba2b5a): adapter, optional service seam, compose wiring, tests, benchmark notes, this specification, three evidence JSON files and one reviewed Engram chunk (0 prompts, 0 credential-pattern hits). The commit hook counted 1,945 authored lines across the five branch commits since origin/main; this slice itself was about 385 authored lines plus generated evidence. Native assess with `committedOnly` and base `4a4b5f0` still returned unassessable (undeclared untracked files): no candidate, reviewDue, lineage or approval. Not retried; the independent static review and local gates remain the outside view.
- L12 — T3/T5 documentation: parent drafted readiness.md (historical demo, current local candidate section, access-log correction, demo row); worker mvq3xuhj-1-z36z added the operator-inputs row and the evidence README closing section, and found no factual mismatch with public-demo-verification.md, observability.ts or config.ts. Parent read the diff back and corrected two README imprecisions (latency samples are ten dashboard GETs per version; only the dashboard body is 191 bytes). Parent checks: in-repo link check over 3 files, 17 relative links, 0 broken, exit0; Prettier on both docs exit0; `git diff --check` exit0. No API/static rerun: no code changed.
- L13 — Confinement incident: the worker wrote `/tmp/linkcheck.py` outside its allowed edit surfaces and outside the repository, ran it, then ran `rm` on it without capturing that exit status. Not authorized and not endorsed retroactively; the parent did not inspect `/tmp` (outside the project) and treats removal as unconfirmed. Its link-check result was superseded by the parent's in-repo stdin check above. The worker's trailing-whitespace check measured `head`, not `grep`, and is discarded.
- L14 — Remaining operator decisions, not authorizations: synthetic least-privilege PostgreSQL connection; disposable coordinated DB/object restore environment and keys; institutional identity/storage/monitoring owners; inherited external-acceptance owners (data quality, Situaciones, media, territorial intelligence); delivery/activation (push, PR, deploy). Native review stays blocked until untracked files are declared or cleared by their owner. SIPGES is a verified local candidate for this slice, not production-ready.
