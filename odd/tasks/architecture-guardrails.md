# Architecture guardrails

First incremental unit: preserve existing inward dependency rules, close the geography-wide token exemption, and map existing UI composition to Atomic Design.
No speculative backend rewrite or mandatory five-folder migration; do not claim an exhaustive architecture certification.

## Specs

- S1: "Clean Architecture & Hexagonal Architecture: Separación estricta de capas. El núcleo (Dominio) debe ser 100% puro, agnóstico a la infraestructura, bases de datos y frameworks. La comunicación externa se maneja estrictamente mediante Puertos e Adaptadores (Interfaces e Implementaciones)."
- S2: "Organic Driven Development (ODD): El desarrollo debe ser evolutivo. No sobre-diseñes. Crea abstracciones que emerjan de necesidades reales y código funcional simple. Prioriza la refactorización continua sobre la arquitectura especulativa."
- S3: "Frontend (Atomic Design + Design System): El cliente debe estructurarse bajo diseño atómico (Átomos, Moléculas, Organismos, Plantillas, Páginas). Todos los componentes deben consumir tokens de un sistema de diseño estructurado y ser modulares."
- S4: "autorizo todo lo necesario y avanza de forma autonoma"

## Tasks

- T1 [done] (S2-S3) Narrow raw-colour exceptions from all geography stylesheets to evidence-backed cartographic files and pin rejected ordinary UI cases plus preserved cartographic cases with tests. Route: worker (parent context backstop). Commit: f38b6dc006a738f205577234b43d8fd8c91589ea.
- T2 [done] (S1-S3) Document the actual ports/adapters boundaries and Atomic Design roles using existing modules; run focused token tests and current dependency boundary check. Route: worker + parent checks. Commit: f38b6dc006a738f205577234b43d8fd8c91589ea.
- T3 [done] (S1-S4) Record truthful evidence, limitations and an isolated local work-unit commit, excluding Cloudflare. Route: parent. Commit: f38b6dc006a738f205577234b43d8fd8c91589ea; closure metadata follows.

## Log

- L1: Original user request:

```text
Actúa como un Arquitecto de Software Senior experto en sistemas distribuidos y asistentes agénticos. 
Restricciones de diseño arquitectónico obligatorias:
1. Clean Architecture & Hexagonal Architecture: Separación estricta de capas. El núcleo (Dominio) debe ser 100% puro, agnóstico a la infraestructura, bases de datos y frameworks. La comunicación externa se maneja estrictamente mediante Puertos e Adaptadores (Interfaces e Implementaciones).
2. Organic Driven Development (ODD): El desarrollo debe ser evolutivo. No sobre-diseñes. Crea abstracciones que emerjan de necesidades reales y código funcional simple. Prioriza la refactorización continua sobre la arquitectura especulativa.
3. Frontend (Atomic Design + Design System): El cliente debe estructurarse bajo diseño atómico (Átomos, Moléculas, Organismos, Plantillas, Páginas). Todos los componentes deben consumir tokens de un sistema de diseño estructurado y ser modulares.
```
- L2: Implementation authorization: "autorizo todo lo necesario y avanza de forma autonoma".
- L3: Exploration found existing domain purity/application direction/context isolation rules in .dependency-cruiser.cjs and composition in API main.ts. No concrete domain import or ambient-clock/randomness violation observed in the bounded sample; this is not exhaustive proof. Avoid a backend rewrite without a demonstrated need.
- L4: Parent spot-check confirms tokens.test.ts exempts every /geography/ path although its comment describes map-paint exceptions only. Correct this test-policy gap, preserve legitimate cartography palettes, and do not silently weaken token enforcement elsewhere. Current frontend shared primitives and feature organization support Atomic Design role mapping without bulk moves.
- L5: Preserve dirty apps/hosting-cloudflare/src/index.ts, its connection test, docs/deployment/readiness.md, odd/tasks/cloudflare-workers.md and odd/evidence/cloudflare-workers/. Branch feat/architecture-guardrails starts at c84135e. No dependencies, auth, data migrations, public API or deployment changes. Forecast under 400 authored lines; one local work-unit commit, no push/PR. Previous global suites timed out; do not retry them for this test/documentation unit. Focused tests, boundary fixture/real-tree scan and targeted formatting are proportionate.
- L6: Worker completed focused RED (exit1, 1 failed/7 passed) then GREEN (exit0, 8 passed). Exact-path policy rejects geography controls and lookalike paths, preserving token definitions and two existing cartographic stylesheet exceptions. Existing contrast/dark-theme checks passed. Source production CSS unchanged. Boundary check exit0: 785 modules, 2244 dependencies. Raw worker output is attributed handoff evidence, not a parent-created transcript.
- L7: Worker added actual port/adapter and Atomic Design role mapping, with explicit limitations on ambient-effect audits and whole-file map exemptions. Parent is checking formatting and cited paths; no exhaustive architecture compliance claim.
- L8: Parent targeted eslint and Prettier check passed. All 14 cited repository paths exist and no local guide link is missing. Evidence is in odd/evidence/architecture-guardrails/README.md with worker attribution and explicit limits. No production behavior changed, so no browser/build or command differential is applicable; no global-suite retry was attempted.
- L9: Native ASSESS returned unassessable due unrelated untracked scope; plan requires writer self-verification and no independent verifier (no high-risk item). No reviewDue continuation supplied; no native approval claimed. Risk: none for this test/documentation unit; it changes no shared production code, dependency, security, persistence or public command contract.
- L10: Commit f38b6dc006a738f205577234b43d8fd8c91589ea (`test(web): enforce exact map colour exceptions`) completed exit0 on feat/architecture-guardrails, 7 files, 152 insertions/13 deletions including generated memory metadata. Engram sync95f901c7 exit0, prompts excluded, credential-pattern scan found no matches (not an absolute privacy guarantee). Verified commit paths contain no Cloudflare work; remaining dirty paths are unrelated Cloudflare files.
- L11: Committed-only native ASSESS from c84135ea0f38ac85602641628c3a1a816ccec091 remains unassessable due unrelated untracked scope. Its plan still requires self-verification and no independent verifier; no reviewDue continuation, native review or approval is claimed. First guardrail unit is complete; no push, PR or deployment. Broader domain-effect audits, intra-map-file colour precision and full UI taxonomy enforcement are not claimed solved or silently added as work.

