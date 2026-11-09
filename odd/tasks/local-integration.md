# Local integration

Integrate the approved feature branches in an isolated local worktree. No cloud actions or changes to the existing desktop instance.

## Specs

- S1 — "hagamos primero todo en local"
- S2 — "yes avanza" (acceptance of the local integration proposal recorded in L2).
- S3 — "en el sidebar dentro del modulo bandeja , hay duplicidad en las secciones , 2 secciones de alertas , calidad de datos , situaciones , correjir porfavor". Selected resolution: "Selector «Filtrar pendientes» (recomendado)".

## Tasks

- T1 [done] — S1–S2 — Merge the approved desktop, fork-ready, collaboration, IRSA and analyst branches into this local branch; preserve their behavior. Route: parent. Commits: edeb93f1, 3cb1b90c, b0b8b552, 61b77fd7, 46a18e8e. All five branch tips verified as ancestors.
- T2 [done] — S1–S2 — Run combined checks and an independent integration verification. Route: parent checks + gentle-ai-verify (installer/build integration). Candidate: 46a18e8e with UI work unit 8a47048. Evidence: L5–L7.
- T3 [done] — S1–S2 — Start an isolated synthetic API/web instance, verify public behavior, document the local handoff and limitations. Route: parent. Candidate: 8a47048. Evidence and handoff: L6–L8.
- T4 [done] — S3 — Replace repeated queue-category buttons with a labelled native filter selector; preserve full hub sections. Route: gentle-ai-worker via context backstop. Checks: 46 inbox/navigation/hub tests, typecheck, eslint, prettier, web build and desktop browser pass. Commit: 8a47048.

## Log

- L1 — User: "hagamos primero todo en local"
- L2 — Accepted proposal: "priorizamos todo en local y dejamos la nube en pausa. No voy a fusionar más PRs mientras eso dispare despliegues automáticos. Voy a preparar una rama de integración local con los cambios aprobados, sin tocar tu checkout principal ni tus datos actuales. Ahí voy a: 1. Integrar los lanzadores, IRSA, analista y flujo de contribuciones. 2. Correr los checks sobre el conjunto integrado. 3. Arrancar SIPGES con datos sintéticos y comprobar el funcionamiento local. La prueba real del instalador de Windows queda para la laptop de Crystell. No voy a presentarla como validada desde Linux."
- L3 — User: "yes avanza"
- L4 — Base origin/main 4031d795 includes PR390. Worktree .worktrees/local-integration, branch chore/local-integration. No push, main merge, deployment, real data or existing localhost:8000 state permitted. Launcher hardcodes port8000 and can reuse the existing service, so it must not be invoked for the isolated smoke.
- L5 — Combined pnpm verify passed (API1121, web517, hosting126, tooling47 plus other workspace tests), web production build passed. Optional API PostgreSQL coverage skipped 32 tests. Extra Go integration command initially panicked in assisted_integration_test.go:69 without SIPGES_TEST_DATABASE_URL; baseline issue previously documented. No test or guard was removed.
- L6 — Started a fresh synthetic PostgreSQL cluster with scripts/agents/test-pg.sh under .data/integration-test-pg (loopback only). Focused Go analyst/config/engines/indicators tests and golangci-lint passed; Rust indicators17 unit +4 parity tests and fmt, actionlint and diffcheck passed. Cluster was stopped using pg_ctl; files retained. These Go results do not replace the skipped optional API PostgreSQL tests.
- L7 — Independent verification concluded S1/S2 met for observed integration and T2, S3 met on desktop with limitations. Existing primary checkout, user data and localhost8000 were not modified. No push/cloud action. Windows runtime unverified. Mobile visual unverified: browser setViewportSize capability unavailable, not retried. Original failed job8 preserved; subsequent job12 passed after supplying its synthetic PostgreSQL prerequisite.
- L8 — Local handoff: API plus built web served at http://127.0.0.1:18080 in a session background process, using .data/local-smoke for synthetic PGlite/uploads/home. Synthetic admin password was supplied only to this disposable instance. Initial raw HTTP login probe failed403 without Origin; browser login succeeded, no auth change. Readiness200, anonymous IRSA401, authenticated IRSA200 with coverage all0 and insufficient_data true. Desktop Bandeja screenshot .data/local-smoke/bandeja-desktop.png inspected; select alerta/calidad/situacion/todo works. This is a temporary session preview, not a replacement for the installed desktop launcher. Data and preview artifacts are ignored by Git.
- L9 — User correction quoted in S3; user selected native filter selector. UI work unit8a47048 changes only the three DecisionInbox files. Delivery strategy: this local branch assembles existing separately reviewable PR units390–395; it is not a new monolithic delivery PR. Keep these original unit boundaries if later publishing. Cloud remains deferred.
