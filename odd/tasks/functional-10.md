# Functional 10/10 (critical walk-through of the running app)

A critical walk-through of the running application, done with ego-browser on a synthetic local
instance, and the list of what must be corrected for the project to be fully functional and well
configured. Every finding below was observed; where a heuristic could be wrong it says «confirm».

## Specs

- S1 — «umm usa ego-browser se critico obsesivo y escribe detalladamente todo lo que tengas que correjir en task para el flujo ODD , objetivo proyecto 100% funcional , bien configurado 10/10»
- S2 — Scope of the walk-through (what S1 was run against): main `0c6b3888` (`visit-rc12` plus #458 and
  #459), the real API (`apps/api/src/main.ts`) serving the built SPA on loopback with a throwaway PGlite
  database, MFA off, synthetic records created by the e2e specs 04, 05, 15, 17, 18, 25, 30 and
  territorio-list. Browser: Chromium 157 through ego-browser, viewport 930×957. Screens visited: `/inicio`,
  `/`, `/registros`, `/eventos`, `/actores`, `/demandas`, `/alertas`, `/pendientes`, `/avisos`,
  `/situaciones`, `/buzon`, `/lecciones`, `/territorio`, `/mapa`, `/bandeja`, `/analisis`, `/situacion`,
  `/irsa`, `/riesgo`, `/validacion`, `/fuentes`, `/integraciones`, `/metodologia`, `/auditoria`,
  `/version-4`, `/proyecto`, a missing page and a missing record; the new-record form, the Ctrl K search
  and the account menu; response headers and static files with curl.
- S3 — Limits of S2, so nothing here reads as proved when it is not: one viewport (930 px; phones are
  covered only by the e2e suite and the rc12 gallery), one browser, one administrator account, no MFA
  enrolment, no second project, no upload larger than a text file, no Go API, no desktop launcher, no
  Windows. Console errors were not captured. Each task below starts by reproducing its findings with a
  failing test.

## Findings

Dates and numbers

- F1 — Raw ISO dates in lists and cards: `/registros`, `/eventos`, `/territorio`, `/riesgo`
  («Alerta territorial Media · 2026-11-14»), Inicio «Evento · 2026-11-14». The same screen also prints
  «15 nov.» and «SÁBADO, 14 DE NOVIEMBRE DE 2026»: three date styles on one page.
- F2 — Raw UTC instants: `/auditoria` has a column «Fecha UTC» with `2026-11-15T03:33:35Z`; `/irsa`
  «Últimos 50 cortes» and `/analisis` print `2026-11-15T03:32:56Z`. A person in Lima reads the 15th for
  something done on the 14th at 22:33.
- F3 — Inicio lists «Alerta activa · 15 nov.» under a header dated 14 November (captured 14 Nov, 22:3x
  Lima). The seed (spec 15) stamps the UTC day; confirm whether any product path also stamps a record's
  date in UTC (new-record default was fixed in #447; check alerts made from the map and automations).
- F4 — Decimal separators mixed: `10.75 / 100`, `7.20`, `100.0%`, `0.1666667` next to «tolerancia 0,02»
  on the same screen. Spanish (Peru) uses the comma; pick one rule for the whole app.
- F5 — IRSA weights table shows `0.1666667` five times and `0.1666665` once: a rounding artefact shown to
  the person as if dimension I weighed less.
- F6 — Three IRSA values without a label that tells them apart: `/irsa` «10.75», Inicio «IRSA 10.8»,
  `/riesgo` «IRSA del proyecto: 2.8» (the last saved cut, not the current index).

Internal names shown to people

- F7 — `/irsa` and `/analisis`: «Contribución active_alert», «high_event», «critical_event», «open_demand»,
  «pending_action», «unverified_narrative».
- F8 — `/situacion` prints stored field names: `Descripcion_Hecho`, `Nivel_Verificacion`, `Fuente_ID`,
  `Nivel_Preliminar`, `Accion_Sugerida`, `Nombre_Actor`, `Posicion_Proyecto`, `Fuente_Principal`.
  `/metodologia` prints `Fuente_ID`.
- F9 — `/auditoria`: action column in English upper case (`CREATE`), and the detail «Registro creado desde
  prototipo V0.2» on records created today in this application.
- F10 — IRSA dimensions appear only as letters (G, A, D, N, E, I) in the chart, the table and the weight
  inputs («Peso G»); the names are never beside them.
- F11 — IRSA cut «Versión» shows `0.4-indicators`.

Wording

- F12 — «(s)» plurals everywhere: «50 de 53 registro(s) mostrados», «0 de 0 registro(s)», «28 día(s).»,
  «48 señal(es) documentada(s).», «15 registro(s) sin ubicación», «1 archivo(s)», «2 narrativa(s)».
- F13 — English or jargon left: the 404 page says «Volver al dashboard»; `/riesgo` says «back-test»;
  `/metodologia` «Brier»; «embeddings» in `situations/ExternalAiCard.tsx` and in the API string «Similitud
  coseno de embeddings del modelo local Ollama» (`intelligence-service.ts:215`, TypeScript and Go together).
- F14 — `/integraciones`: GEOCATMIN shows «Integrado» and «No disponible» at once when its host cannot be
  reached; a sentence is cut («sin programador diario verificado en este se…», confirm whether it is the
  text or my capture).
- F15 — Inicio: the same alert title twice («Registro de prueba 2», two cards) with nothing that tells
  them apart (no id, place or time).

Navigation and pages

- F16 — Configuración lives at `/version-4`; its heading reads «Configuración del proyecto» on the
  «Apariencia» section, which is a device setting. The account menu advertises «Ctrl+,».
- F17 — Missing page: no `h1`, one link, wrong word (F13). Missing record
  (`/objeto/Eventos/NO-EXISTE`): heading «SIPGES» and «Tipo de registro no válido» although the type
  exists and the record does not (confirm with a real module key); no link back.
- F18 — A new installation names its only project «Proyecto Sechura (migración)» /
  `SIPGES/PRJ-SECHURA`, shown in the header of every screen; the project picker is a disabled combobox.
- F19 — Empty modules (`/demandas`, `/buzon`, `/lecciones`) show table headers and «0 de 0 registro(s)
  mostrados · 0 en la consulta» with no empty state or first action.

Accessibility and forms

- F20 — Pointer targets under 24×24 px (WCAG 2.2 SC 2.5.8) outside sentences: Inicio and Panel links
  18–22 px high («Abrir alerta» 73×20, «Ver registros» 78×18), `/alertas` heat-map links 22×19,
  `/riesgo` evidence links 22 px, `/pendientes` and `/situaciones` record links 19–20 px, `/integraciones`
  search input 196×20 and filter buttons 23 px, `/registros` row buttons 918×20.
- F21 — Heading levels skip on `/eventos`, `/actores`, `/demandas`, `/alertas` (one skip each).
- F22 — New-record form (Eventos): 12 fields, 1 required. An empty save shows only the browser's own
  bubble: no `aria-invalid`, no message in the page, no summary. Opening the form moves focus to its
  heading, which is right.
- F23 — Hub sections («Inicio / Panel / Centro gerencial») are a `group` of buttons; confirm that the
  current one is announced (`aria-pressed` or `aria-current`).

Configuration and delivery

- F24 — Versions disagree: `/health` says `V0.5.1`; `package.json` `1.1.0`; model status «Web Final RC
  1.0» and «Prototipo final de tesis | Motor V0.5.1»; IRSA «V0.4» / `0.4-indicators`; tags `visit-rc12`.
- F25 — `/favicon.ico`, `/favicon.svg` and `/robots.txt` answer 401 (the manifest answers 200): the
  sign-in page has no icon in the tab and a crawler gets no rule.
- F26 — Hashed assets are served uncompressed by the Node server (no `content-encoding` with `br, gzip`
  requested): `index` 614 kB, `GeoCanvas` 1.8 MB, `CesiumCanvas` 3.8 MB. On the laptop there is no proxy in
  front, so that is what the browser downloads.
- F27 — Not verified here and still owed: sign-in throttling after repeated wrong passwords (my probe sent
  a body the API rejected with 422, so it proves nothing); MFA enrolment end to end; a second project and
  the tenant switch; the Go API serving the same screens; console errors per screen.
- F28 — Carried from the visit log: Deploy Workers fails at «Apply database migrations» (database
  provider quota exceeded) on every merge since `a6d63c4f`; Ctrl+C and closing the console window during
  `tables.mjs` are unproven on Windows; WebKit runs 7 specs; three more Indicators table captions may be
  cut on phones; map circles of one place stack (design decision).

## Tasks

Each task reproduces its findings first (a failing test per rule), fixes the product, and updates the
docs or help that describe it. Strings the API produces change in TypeScript and Go together, with parity.

- [x] T1 — S1, F1–F3: one date rule. A shared formatter (Lima day, Spanish) for every date and instant
  shown; `<time datetime>` keeps the machine value; Auditoría shows Lima time and says so. Find any
  product path that stamps a record's day in UTC. Route: worker (web + API check). Commit: df329e3c
- [x] T2 — S1, F4–F6: one number rule (decimal comma, fixed decimals per kind), weights shown as
  fractions that add up, and each IRSA value labelled («actual», «último corte»). Route: inline. Commit: df329e3c, 2f169240
- [ ] T3 — S1, F7–F11: no stored key on screen. Labels for IRSA contributions, situational-analysis
  fields, audit actions and versions; dimension names beside their letters; audit detail that says where
  a record was really created. Test: no `/[a-z]+_[a-z]+|[A-Z][a-z]+_[A-Z]/` in any screen's text. Route:
  worker (web, API TypeScript + Go). Commit: —
- [x] T4 — S1, F12: plural helper for counts (registro/registros, día/días, señal documentada/señales
  documentadas, archivo/archivos) and no «(s)» left. Test: no `(s)` or `(es)` in any screen. Route: inline.
  Commit: df329e3c, 2f169240
- [ ] T5 — S1, F13–F15: wording (404 link, «prueba retrospectiva», Brier explained, «embeddings» in the
  two remaining places), one state per integration, and alert cards on Inicio that can be told apart.
  Route: inline (API string with Go). Commit: —
- [ ] T6 — S1, F16–F19: `/configuracion` with a redirect from `/version-4`; section headings that match;
  real not-found pages with a heading and a way back, and «registro no encontrado» distinct from «tipo no
  válido»; a neutral default project name for a new installation (migration needed for none: new installs
  only; existing data is never renamed); empty states with a first action. Route: worker. Risk: item 3
  (route and default name others consume). Commit: —
- [ ] T7 — S1, F20–F23: 24 px minimum targets through the shared link/button styles, heading order,
  in-page form errors (`aria-invalid`, message, focus on the first error) for every module form, and the
  current hub section announced. Test: an axe pass plus a target-size check on every screen at 360, 930
  and 1440 px. Route: worker. Commit: —
- [ ] T8 — S1, F24: one version source (the release tag or `package.json`) for `/health`, the model
  status and the screens; the IRSA method version stays separate and is labelled as such. Route: inline
  (TypeScript + Go, parity). Risk: item 3 (`/health` is read by `sipgesctl` and the launchers). Commit: —
- [ ] T9 — S1, F25–F26: public static files (icons, `robots.txt`) without a session; precompressed
  assets (brotli and gzip) served by the Node and Go servers; bundle budget checked in CI. Route: worker.
  Risk: item 2 (what is public without a session). Commit: —
- [ ] T10 — S1, F27: the journeys not walked: wrong-password throttling, MFA enrolment, a second project
  and switching, the same walk-through against the Go API, console errors per screen; each becomes an
  e2e or `sipgesctl verify` step. Route: worker + independent verifier. Risk: item 2. Commit: —
- [ ] T11 — S1, F28 and S3: the same walk-through at 360 px and on WebKit; the three Indicators captions;
  the Windows interrupt drill step. Route: worker. Commit: —
- [ ] T12 — S1: release. `visit-rc13` on the commit that holds T1–T11 with CI and the Windows drill
  green, roadmap log entry, gallery regenerated and every image reviewed. Route: inline. Commit: —

Owner decisions these tasks do not take: the cloud database plan (F28), grouping map circles into one
marker with a count (F28), and the default project name of T6 if «Proyecto 1» is not wanted.

## Log

- L1 — «umm usa ego-browser se critico obsesivo y escribe detalladamente todo lo que tengas que correjir en task para el flujo ODD , objetivo proyecto 100% funcional , bien configurado 10/10»
- L2 — Walk-through done as S2 describes, on a loopback instance at port 4310 with synthetic credentials
  generated for the run; 27 addresses, three interactions, headers and static files. Findings F1–F28
  written from what the screens and responses showed; F3, F14, F17, F23 and all of F27 are marked to confirm.
  No product code changed by this document.
- L3 — «perfect autorizo todo , and continue con cada tarea»
- L4 — T1, T2 and T4 closed. Dates: one Lima/Spanish formatter (`shared/lib/format.ts`, `ui/DateText.tsx`)
  for every day and instant; Auditoría in Lima time. Numbers: decimal comma, fixed decimals per kind,
  charts included, weights as shares that add up, IRSA labelled «IRSA actual» / «IRSA del último corte
  guardado». Plurals: `shared/lib/plural.ts`, and the situation reasons in TypeScript and Go («5 días»,
  «1 registro», «Puntaje 8,77»), byte-identical. F3: no product path stamps a record's day in UTC (API day
  arithmetic starts from `limaToday`; only e2e spec 15 seeds UTC days). Evidence: web unit 664/664 with
  guard tests (no `toLocale*String`, `toFixed` or «(s)» in UI source); api situations 28/28; `go test
  ./internal/situations/...` ok and `generate.mjs --check` 0; `pnpm parity` exit 0 (Node 22, throwaway
  PostgreSQL); e2e chromium 04 05 06 15 17 18 19 25 30 territorio-list 25 passed / 5 opt-in skipped;
  mobile-chromium 73 passed, plus `registros-types` 3/3 after its ISO expectation was updated; an
  ego-browser scan of seven screens on a fresh synthetic instance found no ISO date, decimal point or
  «(s)» outside Situaciones, whose strings come from the API (fixed in `2f169240`). Commits `2f169240`,
  `df329e3c`; the slice passes 400 lines because the generated `fixtures.json` is about 1500 of them.
