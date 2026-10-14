# Full Functionality

Make every module of MASCLI work end to end, on desktop and on a phone, and prove it with tests that act like a person: every record module, every workflow screen and every role. Branch `claude/project-thread-fzmueu` from `main` 9e4bb3b. Maps and the shell/navigation belong to the open "Rediseño mobile-first" PR #47 and are not touched here. Synthetic data only; no deployment and no real-data import without the owner's word.

## Specs
- S1: "Hey bro crea ODD o lo que sea necesario pero todo los módulos todo el proyecto debe ser funcional 10/10" (owner, 2026-10-14).
- S2: Method from the coordinator brief: walk every module and every action end to end in the real app (desktop and phone, Playwright E2E), record what fails or is only visual, and fix it with regression tests. Start from an updated `main`; do not touch maps or the shell/navigation (PR #47); demo records stay apart through `recordOrigin`; no invented real data.
- S4: "Continúe" (owner, 2026-10-14, after T1-T8): keep going on the same PR; `main` now includes PR #47 (maps).
- S5: "La ubicación geoespacial debe verse bien, realista o en vivo y el mapa territorial está muy lento para moverlo verlo, todo debe ser fluido" (owner, 2026-10-14).
- S6: "Porque se ve lento has lo que sea necesario todo debe verse fluido y bien" (owner, 2026-10-14).
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
- F6 (record card, phone): opening an evidence viewer pushed it into a second flex column beside the file (`flex-direction: column` with `flex-wrap: wrap` turned its 100% basis into a height), 686 px on a 412 px phone; the page zoomed out and taps landed on the wrong controls («Vincular» could not be pressed).
- F7 (record history): attachments and other structured values were shown as raw JSON (`[{"id":"ADJ-…","archivo":…}]`).
- F8 (Automatizaciones): deleting a rule or a channel happened at once, without the confirmation records have (was an observation in L1).
- F9 (both maps): dragging or pinching stuttered: with 4× CPU throttling the p95 frame was 267 ms. A trace showed 12 s of rasterising per 120 pointer moves: district outlines kept a CSS dash of 0.01 map units (about 1 m since maps moved to scaled units), millions of dashes per district. Every pointer move also re-rendered the whole page.
- F10 (Ubicación geoespacial): no basemap at all, only generalised districts; it did not look like a real place.
- F11 (whole app): every response, hashed JS and CSS included, carried `Cache-Control: no-store` (API middleware and `vercel.json`), so each visit and reload downloaded the whole bundle again (724 KB) through the server function.
- F12 (navigation): each screen change waited for `/system/auth/me` and then `/system/auth/current-scope` once their one-minute cache aged, and each screen's code was fetched only when first opened.
- Observations, not changed: production (`main`) does not have these fixes until this PR is merged; serverless cold starts and the database waking up are hosting limits outside the code.
- Observations, not changed: Validación only downloads the expert template by design (no ratings are stored); maps are left to PR #47.

## Tasks
- T1 [x] S1,S2 — This ODD: inventory, method, sweep findings; route: inline; commit: see L2
- T2 [x] S1,S2 — Record modules: E2E create, search, read, edit and delete for all 14 modules on desktop and phone (`12-module-crud`); route: inline; commit: see L3
- T3 [x] S1,S2 — Digital signal to completed preventive plan (`13-workflows`); fix F1 with a shared `useReveal` hook; route: inline; commit: see L4
- T4 [x] S1,S2 — Administración journey (accounts, Google link, project, grant, revoke, deactivate); fix F2; route: inline; commit: see L5
- T5 [x] S1,S2 — CSV import, links, history and audit trail journey; fix F3; route: inline; commit: see L6
- T6 [x] S1,S2 — Document review decision, strategic reports, chronology filters and automation rules/channels journeys; fix F4 and F5 (`DemoDataNotice`); route: inline; commit: see L7
- T7 [x] S1,S3 — Roles and navigation: every screen for analista, coordinador and consulta without errors or refused requests (`14-roles`); every home-screen link opens a real screen; route: inline; commit: see L8
- T8 [x] S3 — Unit regressions, `pnpm verify` with PostgreSQL, full `pnpm e2e`; route: verify; commit: see L9

- T9 [x] S4 — Shared `ConfirmDialog` (records' dialog moved to `shared/ui`); confirmation before deleting automation rules and channels (F8); route: inline; commit: see L10
- T10 [x] S4 — 360° view journey: approve an analyst proposal and restrict a record for read-only accounts, desktop and phone; route: inline; commit: see L11
- T11 [x] S4 — Evidence upload and viewer in the phone journey; fix F6 (viewer layout) and F7 (readable history values); route: inline; commit: see L12
- T12 [x] S3,S4 — Verification after merging `main` (PR #47): `pnpm verify` with PostgreSQL and full `pnpm e2e`; route: verify; commit: see L13
- T13 [x] S5 — Smooth maps: dashes sized to the view (F9), gestures move a transform and render once at the end, tiles with margin and the previous level kept until the new one loads; route: inline; commit: see L14
- T14 [x] S5 — Basemap choice (satellite Sentinel-2 cloudless, streets, none) on both maps, satellite by default on the project location (F10); ADR 0006 addendum and CSP; route: inline; commit: see L15
- T15 [ ] S6 — Fluid app: hashed assets cached for a year by browsers and the CDN (F11), navigation reuses the session and project already known and refreshes them in the background, other screens preloaded while idle (F12); route: inline; commit: pending
## Log
- L1 (plan, 2026-10-14): Inventoried 21 screens, 14 record modules and 4 roles on `main` 9e4bb3b; ran the M1 sweep on the synthetic academic case; findings F1-F5 above.
- L2 (T1 ODD): Inventario de 21 pantallas, 14 módulos de registros y 4 roles; barrido exploratorio en Chromium de escritorio sobre la API real con el caso académico sintético (122 registros): cada control visible de <main> pulsado en una carga limpia; hallazgos F1-F5 (ac7a3d2).
- L3 (T2 módulos de registros): 12-module-crud (escritorio) y 12-module-crud.mobile (Pixel 7): crear, buscar, ver, editar desde la ficha y eliminar con confirmación en los 14 módulos, comprobando el valor guardado y el 404 por API; 28/28 sin defectos (ac7a3d2).
- L4 (T3 alertas y planes): 13-workflows: texto analizado, alerta registrada, corroborada, plan preventivo creado y avanzado a 40 % y a Completada 100 %. F1 reproducido (el encabezado de la alerta no recibía foco) y corregido con useReveal en IntelligencePage y ManagementPage (ac7a3d2).
- L5 (T4 administración): Cuenta analista, vínculo de Google, proyecto nuevo, acceso concedido y revocado, cuenta desactivada; cada aviso y confirmación debe quedar en la vista. F2 reproducido (aviso «Cuenta creada.» con ratio de vista 0) y corregido (ac7a3d2).
- L6 (T5 importación, vínculos e historial): Importación CSV de 2 actores (revisar e importar), vínculo «es aliado de» creado y quitado, historial v1 Creación y entrada IMPORT en Auditoría. F3: el panel de importación recibe foco y se desplaza a la vista (ac7a3d2).
- L7 (T6 análisis y automatizaciones): Decisión «Corroborado documentalmente» en la bandeja documental y filtro, tres informes estratégicos DOCX, filtro de cronología por tipo; reglas creadas, editadas, pausadas, reactivadas y eliminadas, canal webhook creado y eliminado. F4 reproducido revirtiendo la corrección (aviso «Regla creada.» no encontrado en la vista) y corregido. F5: DemoDataNotice en IRSA, Análisis situacional e Inteligencia estratégica (ac7a3d2).
- L8 (T7 roles y navegación): 14-roles: analista, coordinador y consulta abren las 21 pantallas sin banners de error ni peticiones rechazadas (4xx/5xx en /api y /system); los enlaces del inicio abren pantallas reales en escritorio y móvil; sin defectos (ac7a3d2).
- L9 (T8 verificación): pnpm verify con PostgreSQL 16 sintético local (MASCLI_TEST_DATABASE_URL explícito): lint, formato, límites, tipos, API 576 (0 omitidas), web 169, kernel 3, hosting 6, herramientas 4. pnpm e2e 78 pasadas, 1 omitida (capturas opcionales). Pruebas unitarias nuevas: reveal.test y DemoDataNotice.test. Sin datos reales ni despliegue (ac7a3d2).
- L10 (confirmación al eliminar): Eliminar reglas y canales de automatización pide confirmación con un ConfirmDialog compartido (el de registros se movió a shared/ui): Cancelar conserva, Escape cierra, el foco queda atrapado y vuelve. F8 corregido (5a4e141).
- L11 (vista 360°): 13-workflows (escritorio y Pixel 7): evento que menciona un actor, propuesta del analista aprobada desde la vista 360° y vínculo creado; registro marcado restringido deja de ser legible para la cuenta consulta (5a4e141).
- L12 (evidencias e historial): Evidencia subida y leída en la ficha en escritorio y teléfono. F6: el visor abría una segunda columna de 686 px en un teléfono de 412 px y los toques fallaban; corregido en CSS con comprobación de ancho en E2E. F7: el historial muestra adjuntos y valores estructurados legibles (readable, prueba unitaria) (5a4e141).
- L13 (verificación): Tras fusionar main (PR #47): pnpm verify con PostgreSQL 16 sintético: API 576 (0 omitidas), web 172, kernel 3, hosting 6, herramientas 4. pnpm e2e 80 pasadas, 1 omitida (capturas opcionales). Sin datos reales ni despliegue (5a4e141).
- L14 (mapas fluidos): Traza de un arrastre con CPU 4× más lenta: 12 s de rasterizado por 120 movimientos, causados por el trazo punteado de los distritos (guion de 0,01 unidades, unos 1 m). Guiones proporcionales a la vista: p95 por fotograma de 267 ms a 17 ms. Los gestos mueven una transformación SVG y React dibuja una sola vez al soltar; mosaicos con margen y el nivel anterior visible hasta que carga el nuevo. Pruebas: MapFrame.test (arrastre y guiones), TileLayer.test y 08-territorial-map (5d64c37).
- L15 (mapa base satelital): Selector Mapa base (Satélite, Calles, Sin mapa base) en Ubicación geoespacial (satélite por defecto) y Mapa territorial. Satélite: Sentinel-2 cloudless 2020 de EOX, CC BY-NC-SA 4.0, crédito enlazado bajo el mapa; CSP img-src y regla de host E2E; addendum en ADR 0006. pnpm verify con PostgreSQL (API 576, web 177) y pnpm e2e 80 pasadas, 1 omitida (5d64c37).
