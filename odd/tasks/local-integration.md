# Local integration

Integrate the approved feature branches in an isolated local worktree. No cloud actions or changes to the existing desktop instance.

## Specs

- S1 — "hagamos primero todo en local"
- S2 — "yes avanza" (acceptance of the local integration proposal recorded in L2).

## Tasks

- T1 [in_progress] — S1–S2 — Merge the approved desktop, fork-ready, collaboration, IRSA and analyst branches into this local branch; preserve their behavior. Route: parent. Commit: pending.
- T2 [pending] — S1–S2 — Run combined checks and an independent integration verification. Route: parent checks + gentle-ai-verify (installer/build integration). Commit: evidence pending.
- T3 [pending] — S1–S2 — Start an isolated synthetic API/web instance, verify public behavior, document the local handoff and limitations. Route: parent. Commit: pending.

## Log

- L1 — User: "hagamos primero todo en local"
- L2 — Accepted proposal: "priorizamos todo en local y dejamos la nube en pausa. No voy a fusionar más PRs mientras eso dispare despliegues automáticos. Voy a preparar una rama de integración local con los cambios aprobados, sin tocar tu checkout principal ni tus datos actuales. Ahí voy a: 1. Integrar los lanzadores, IRSA, analista y flujo de contribuciones. 2. Correr los checks sobre el conjunto integrado. 3. Arrancar SIPGES con datos sintéticos y comprobar el funcionamiento local. La prueba real del instalador de Windows queda para la laptop de Crystell. No voy a presentarla como validada desde Linux."
- L3 — User: "yes avanza"
- L4 — Base origin/main 4031d795 includes PR390. Worktree .worktrees/local-integration, branch chore/local-integration. No push, main merge, deployment, real data or existing localhost:8000 state permitted. Launcher hardcodes port8000 and can reuse the existing service, so it must not be invoked for the isolated smoke.
