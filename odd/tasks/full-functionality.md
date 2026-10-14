# Full Functionality

Make every module of MASCLI work end to end, on desktop and on a phone, and prove it with tests that act like a person: every record module, every workflow screen and every role. Branch `claude/project-thread-fzmueu` from `main` 9e4bb3b. Maps and the shell/navigation belong to the open "Rediseño mobile-first" PR #47 and are not touched here. Synthetic data only; no deployment and no real-data import without the owner's word.

## Specs
- S1: "Hey bro crea ODD o lo que sea necesario pero todo los módulos todo el proyecto debe ser funcional 10/10" (owner, 2026-10-14).
- S2: Method from the coordinator brief: walk every module and every action end to end in the real app (desktop and phone, Playwright E2E), record what fails or is only visual, and fix it with regression tests. Start from an updated `main`; do not touch maps or the shell/navigation (PR #47); demo records stay apart through `recordOrigin`; no invented real data.
- S3: Keep the existing guarantees: hexagonal boundaries, tenant isolation, ADR 0007 HTTP contract, CSP, WCAG 2.1 AA, and every existing unit and E2E test green.

## Inventory
- Record modules (14, generic `RecordsPage`): eventos, actores, directorio, demandas and compromisos (`/demandas`), narrativas, fuentes, alertas and acciones (`/alertas`), intereses, diálogos, oportunidades, hechos and AARC (`/estrategia`). Each one: create, search, read, edit, delete, CSV import, evidence, links, history.
- Workflow screens (14): Dashboard/Hoy, Centro gerencial, Inteligencia de redes, Mapa territorial, Ubicación geoespacial, Cronología, Análisis situacional (document lab and review inbox), Inteligencia estratégica, IRSA, Validación, Administración, Automatizaciones, Metodología, Auditoría.
- Roles: admin, analista, coordinador, consulta.

## Method
- M1: Exploratory sweep (desktop Chromium against the real API with the 122-record synthetic academic case): every screen, every visible control in `<main>` clicked on a fresh load, recording page errors, failed requests and controls that changed nothing. Destructive controls were skipped; maps were only observed.
- M2: Journeys as E2E tests: each module and workflow driven through the UI from start to finish, on `Desktop Chrome` and `Pixel 7`, asserting the stored result through the API and that every outcome is visible where the person is looking (`toBeFocused`, `toBeInViewport`).

## Findings
- F1 (Inteligencia de redes, Centro gerencial): «Ver alerta …» and «Ver plan …» rendered the review and progress forms after the whole table, without focus or scroll; with several alerts or plans, and always on a phone, the click looked like it did nothing (same defect class as audit error 03).
- F2 (Administración): success and error notices render at the top of a long page and the «Confirmación requerida» card below the grant form; creating an account, linking Google, creating a project or granting access showed no visible result, and «Desactivar» or «Revocar acceso» only disabled every form while the confirmation stayed off-screen.
- F3 (every record module): «Importar CSV» opened its panel after the whole list; on a long list or a phone it appeared off-screen.
- F4 (Automatizaciones): the same off-screen notices as F2 for channels and rules further down, and «Editar» on a rule filled a form below the list without bringing it into view.
- F5 (IRSA, Análisis situacional, Inteligencia estratégica): the dashboard counts real records only, but these engines read every record, demo included (audit pending item 4), so their figures did not match the dashboard and nothing said why.
- No defect found in: create/search/read/edit/delete of the 14 record modules on desktop and phone; CSV review and apply; links and history; evidence; document review decisions; strategic DOCX reports; chronology filters; automation rules and channels; account, project and grant administration; home-screen links; any screen for analista, coordinador or consulta (no error banner, no refused request).
- Observations, not changed: deleting an automation rule or channel has no confirmation step; Validación only downloads the expert template by design (no ratings are stored); maps are left to PR #47.

## Tasks
- T1 [ ] S1,S2 — This ODD: inventory, method, sweep findings; route: inline; commit: pending
- T2 [ ] S1,S2 — Record modules: E2E create, search, read, edit and delete for all 14 modules on desktop and phone (`12-module-crud`); route: inline; commit: pending
- T3 [ ] S1,S2 — Digital signal to completed preventive plan (`13-workflows`); fix F1 with a shared `useReveal` hook; route: inline; commit: pending
- T4 [ ] S1,S2 — Administración journey (accounts, Google link, project, grant, revoke, deactivate); fix F2; route: inline; commit: pending
- T5 [ ] S1,S2 — CSV import, links, history and audit trail journey; fix F3; route: inline; commit: pending
- T6 [ ] S1,S2 — Document review decision, strategic reports, chronology filters and automation rules/channels journeys; fix F4 and F5 (`DemoDataNotice`); route: inline; commit: pending
- T7 [ ] S1,S3 — Roles and navigation: every screen for analista, coordinador and consulta without errors or refused requests (`14-roles`); every home-screen link opens a real screen; route: inline; commit: pending
- T8 [ ] S3 — Unit regressions, `pnpm verify` with PostgreSQL, full `pnpm e2e`; route: verify; commit: pending

## Log
- L1 (plan, 2026-10-14): Inventoried 21 screens, 14 record modules and 4 roles on `main` 9e4bb3b; ran the M1 sweep on the synthetic academic case; findings F1-F5 above.
