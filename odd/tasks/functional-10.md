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

- S4 — «yes haslo , te autorizo todo , ve que funcione tambien por cli , mcp , api , ego-browser y mas»
  (answering the proposal to open T14 for the rc14 gallery dudas that need no owner decision and the technical
  leftovers of L6/L9).

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

Found by the visit-rc13 gallery (122 images, every one opened)

- F29 — Raw ISO dates T1 did not reach: the record sheet «Fecha 2026-10-12» while its list row reads «12 oct.
  2026» (`registros-*-ficha`, `registros-tabla-1440`); Seguimiento de compromisos «Fecha de referencia:
  2026-11-15 (America/Lima)»; Fuentes oficiales «comprobada el 2026-10-17».
- F30 — Auditoría breaks words letter by letter at 360 px and «Automatiz/iones» at 1440 px; the IRSA weight
  inputs still show «0.1666667»/«0.1666665» and the bands «24.99 / 49.99 / 74.99» with a decimal point.
- F31 — Smaller ones: Inicio level pills wrap at 360 px and push «Esta semana» under the composer; «1 de 1
  registros»; «Crear alerta rojo» (gender); IRSA tables at 360 px cut columns with no scroll cue; the
  Configuración page has no visible title at 1440 px; the not-found page renders without the app shell; the
  Proyecto card reads «Proyecto · SIPGES» instead of the project name; a stray «—» with no label in the
  Registros sheet; the opt-in Territorio captures wait for the old «registro(s) sin ubicación» text
  (`apps/e2e/support/territorio-capture.ts:87`), so 8 capture tests time out.

## Tasks

Each task reproduces its findings first (a failing test per rule), fixes the product, and updates the
docs or help that describe it. Strings the API produces change in TypeScript and Go together, with parity.

- [x] T1 — S1, F1–F3: one date rule. A shared formatter (Lima day, Spanish) for every date and instant
  shown; `<time datetime>` keeps the machine value; Auditoría shows Lima time and says so. Find any
  product path that stamps a record's day in UTC. Route: worker (web + API check). Commit: df329e3c
- [x] T2 — S1, F4–F6: one number rule (decimal comma, fixed decimals per kind), weights shown as
  fractions that add up, and each IRSA value labelled («actual», «último corte»). Route: inline. Commit: df329e3c, 2f169240
- [x] T3 — S1, F7–F11: no stored key on screen. Labels for IRSA contributions, situational-analysis
  fields, audit actions and versions; dimension names beside their letters; audit detail that says where
  a record was really created. Test: no `/[a-z]+_[a-z]+|[A-Z][a-z]+_[A-Z]/` in any screen's text. Route:
  worker (web, API TypeScript + Go). Commit: #462 545e29b7
- [x] T4 — S1, F12: plural helper for counts (registro/registros, día/días, señal documentada/señales
  documentadas, archivo/archivos) and no «(s)» left. Test: no `(s)` or `(es)` in any screen. Route: inline.
  Commit: df329e3c, 2f169240
- [x] T5 — S1, F13–F15: wording (404 link, «prueba retrospectiva», Brier explained, «embeddings» in the
  two remaining places), one state per integration, and alert cards on Inicio that can be told apart.
  Route: inline (API string with Go). Commit: #462 545e29b7
- [x] T6 — S1, F16–F19: `/configuracion` with a redirect from `/version-4`; section headings that match;
  real not-found pages with a heading and a way back, and «registro no encontrado» distinct from «tipo no
  válido»; a neutral default project name for a new installation (migration needed for none: new installs
  only; existing data is never renamed); empty states with a first action. Route: worker. Risk: item 3
  (route and default name others consume). Commit: #464 0a9b1226
- [x] T7 — S1, F20–F23: 24 px minimum targets through the shared link/button styles, heading order,
  in-page form errors (`aria-invalid`, message, focus on the first error) for every module form, and the
  current hub section announced. Test: an axe pass plus a target-size check on every screen at 360, 930
  and 1440 px. Route: worker. Commit: #465 7c1e155b
- [x] T8 — S1, F24: one version source (the release tag or `package.json`) for `/health`, the model
  status and the screens; the IRSA method version stays separate and is labelled as such. Route: inline
  (TypeScript + Go, parity). Risk: item 3 (`/health` is read by `sipgesctl` and the launchers). Commit: #462 545e29b7
- [x] T9 — S1, F25–F26: public static files (icons, `robots.txt`) without a session; precompressed
  assets (brotli and gzip) served by the Node and Go servers; bundle budget checked in CI. Route: worker.
  Risk: item 2 (what is public without a session). Commit: #464 0a9b1226
- [x] T10 — S1, F27: the journeys not walked: wrong-password throttling, MFA enrolment, a second project
  and switching, the same walk-through against the Go API, console errors per screen; each becomes an
  e2e or `sipgesctl verify` step. Route: worker + independent verifier. Risk: item 2. Commit: #466 3b05c0dc, #467 6b4a3a62
- [x] T11 — S1, F28 and S3: the same walk-through at 360 px and on WebKit; the three Indicators captions;
  the Windows interrupt drill step. Route: worker. Commit: #468 cc27b30e
- [x] T12 — S1: release. `visit-rc13` on the commit that holds T1–T11 with CI and the Windows drill
  green, roadmap log entry, gallery regenerated and every image reviewed. Route: inline. Commit: tags visit-rc13 (cc27b30e) and visit-rc14 (b51f2e7d); #469

- [x] T13 — S1, F29–F31: close what the rc13 gallery found. Dates and numbers through the shared helpers
  in the record sheet, Seguimiento, Fuentes oficiales and the IRSA weight and band inputs (decimal comma,
  inputs still accept what they accept today); Auditoría readable at 360 and 1440 px; the F31 list; the
  capture helper regex. Each with a failing test first; then regenerate the gallery and review it again.
  Route: worker. Commit: #470 b51f2e7d

- [x] T14 — S4, L9: the rc14 gallery dudas that need no owner decision. Alerts that share a title are told
  apart on Panel and the phone home; the Territorio list shows its fifth row whole and the page shows one «Alertas
  abiertas» count; tablet Eventos names the dimension; Auditoría at 1440 px has a visible title and shows the project
  label, not `SIPGES/PRJ-SECHURA`; the dark active segment in Configuración has enough contrast (measure it).
  Route: worker (web). Commit: see L11
- [x] T15 — S4, L6: technical leftovers. «back-test» and `Fuente_ID` reworded at the source (Rust engines, their
  TypeScript twins and the wasm, byte-identical); a CI job running the e2e suite on the Go API
  (`SIPGES_E2E_RUNTIME=go`, fixed spec list); the desktop kit version (`builder.mjs --version`) checked against
  package.json; the review advisories (database name validated before CREATE, timeouts on `go build` and
  `migrate`, the POSIX-path test in tables-interrupt.test.mjs, its failure paths run on Windows). Route: worker.
  Risk: item 5 (CI). Commit: see L12
- [ ] T16 — S4: prove it works through every surface on the release candidate: `sipgesctl verify
  --synthetic-target` (CLI), the MCP server (list tools, call a read and a write tool, refusals without a key),
  the HTTP API (parity, `/health`, a write and a read), the Go API, and an ego-browser walk of every screen on a
  fresh synthetic instance; each defect found becomes a fix with a test. Route: worker + parent (ego-browser).
  Commit: —
- [ ] T17 — S4: release `visit-rc15` on the commit holding T14–T16 with CI and the Windows drill green, roadmap
  entry, gallery regenerated and every image reviewed. Route: inline. Commit: —

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
- L5 — «avanza» (twice, while T3–T11 were in progress).
- L6 — T3, T5–T11 closed, each merged with CI green on its exact head. T3/T5/T8 (#462): Spanish labels for
  every stored key, «Registro creado en SIPGES» for new records (TS and Go), 404 «Volver al inicio»,
  «prueba retrospectiva», no «embeddings», one state per integration, alerts that share a title show place and
  id; `/health` and model status take the root package.json version (independent verifier: pass, no consumer
  parses it). T6/T9 (#464): `/configuracion` with the `/version-4` redirect, real not-found pages, «Proyecto
  principal» for NEW installations only (a stored label survives; TS test and Go DB test), empty states with a
  first action; favicon and robots.txt public, brotli/gzip assets in Node and Go (independent verifier: pass,
  342 raw-socket probes, nothing else became public). T7 (#465): 24 px targets through shared styles, no heading
  skips, in-page form errors in the editor of all 16 modules, hub section pinned; spec 38 checks every screen at
  360/930/1440 px with axe. T10 (#466, #467): sign-in throttling e2e (429, Retry-After 900, per user), console
  and same-origin errors per screen, and `SIPGES_E2E_RUNTIME=go`: 61 specs pass on the Go API with the same
  counts as Node (native review approved). T11 (#468): a Safari select overflow fixed for every select, the
  Indicators captions fit phones, specs 35/37/38/text-fit on WebKit offline (105/105 ×3), and a Windows CI step
  that interrupts tables.mjs with a real console Ctrl+C (passed on the Windows runner; native review approved).
  Found on the way and fixed: parity and the CLI drill reached the live www.defensoria.gob.pe, which stopped
  answering on 2026-11-15 ~06:40Z and turned main red (#463: `SIPGES_DEFENSORIA_URL` and a local double; the
  route sweep tolerates 502/504 from reads marked `upstream`).
  Still open (not in T1–T11 or decided by the owner): «back-test» and `Fuente_ID` come from the Rust engines and
  are only reworded on screen; closing the console window during tables.mjs is unproven on Windows
  (CTRL_CLOSE_EVENT cannot be generated); the Ctrl+C drill does not prove the copy was still in flight; no CI
  job runs the Go e2e runtime yet; the desktop release version (`builder.mjs --version`) is a second version
  channel; review advisories on the Go harness (validate the database name before CREATE, bound `go build`) and
  on the Windows helper (POSIX paths in one test, failure paths not run on Windows); map circles and the cloud
  database quota stay owner decisions.
- L7 — `visit-rc13` published on cc27b30e (CI and the Windows drill green on that commit). Its gallery
  (`.worktrees/rc13-gallery/.data/rc13-screens/`, 122 images) counts 66 ok / 41 duda / 15 defecto against rc12's
  64 / 26 / 0; none of the 15 is a regression (the 9 on rc12 images were already there, unmarked). F29–F31 and
  T13 added; T12 stays open until the T13 gallery is clean.
- L8 — T13 closed (#470, b51f2e7d): every F29–F31 item, plus two layout regressions CI's wider fonts exposed
  (implicit `auto` grid tracks on Inicio and Auditoría; now `minmax(0, 1fr)`) and a keyboard-unreachable
  Auditoría scroll region. A signed-out visit to an unknown address now goes to sign-in first.
- L9 — T12 closed. `visit-rc14` on b51f2e7d, CI and the Windows drill green on that commit. Final gallery
  (`.worktrees/rc14-gallery/.data/rc14-screens/`, 122 images, every one opened and classified again): 93 ok /
  29 duda / 0 defecto (rc13 66/41/15, rc12 64/26/0); all 15 rc13 defects fixed, no regression. The 29 dudas, by
  cause: identical alerts that cannot be told apart on Panel and the phone home (5), stacked map circles (12,
  owner decision F28), the Territorio list's fifth row and full-page timeline dots / two «Alertas abiertas»
  counts (5), tablet Eventos with dimension letters (2), artefact captures (4: actor-map labels, heat-map scroll
  hint, a painted top bar in two full-page captures), Configuración dark active segment and a gap (2),
  Auditoría at 1440 px without a visible title showing «SIPGES/PRJ-SECHURA».
- L10 — «yes haslo , te autorizo todo , ve que funcione tambien por cli , mcp , api , ego-browser y mas». S4,
  T14–T17 added. Still owner decisions: stacked map circles, the cloud database plan, the real laptop's version
  and backup.
- L11 — T14 closed (f6204e14..89298ea1, resumed by a delegated writer from the uncommitted work of the earlier tab,
  which had died). Each rc14 gallery duda without an owner decision has a test that fails on base: the phone Panel
  shows place and id under alerts that share a title, and the IRSA card names each dimension (F10). On Territorio the
  map list ends on a whole fifth row, the timeline dots are whole, and the two counts read «Alertas abiertas
  vinculadas» and «Alertas abiertas del proyecto» (they count different things; one literal «Alertas abiertas» label
  is a one-line revert if the owner wants it). Tablet Eventos shows «N · Narrativas» with a 12rem description column.
  Auditoría at 1440 px has a visible title and the project label without its scope. The chosen segment in
  Configuración has an outline: 3.67:1 dark and 3.35:1 light against its neighbours (it was 1:1 and 1.1:1), text
  15.3:1 and 19.44:1, from computed styles in Chromium. The heat map and the actor map shadow their scroll edges on
  phones. e2e zz-gallery-rc14 (desktop 4, mobile 5) red on base then green, web unit tests 754/754, hubs.mobile and
  spec 38 (axe at 360/930/1440 px) green; typecheck, eslint, prettier and build ok. Risk: none.
- L12 — T15 closed (f24d460c..7ffeee58 plus a SIGKILL fix, resumed by a delegated writer from the uncommitted work of
  the earlier tab, which had died). «prueba retrospectiva» and «referencia de fuente» at the source: Rust
  conflict-risk and indicators, their TypeScript twins, fixtures current (41 and 96 cases), Go writes golden, wasm
  rebuilt by build-wasm.sh with wasi-sdk 27 to the same sha256; the screen's rewording shim removed (labels.ts keeps
  «Fuente_ID» → «referencia de fuente» for method texts saved before). CI job `e2e-go` (not required):
  SIPGES_E2E_RUNTIME=go, specs 06 07 34 35 37 01 03 14, 26 passed locally on synthetic PostgreSQL. builder.mjs checks
  --version against package.json and refuses another release version before writing; pre-releases are rehearsals.
  Beyond the letter of T15, kept and disclosed: builder.mjs defaults --version to package.json, and
  tables-interrupt.mjs refuses a non-empty work folder. Scratch database name validated before CREATE; go build 10 min
  and migrate 2 min limits now kill with SIGKILL (a tool ignoring SIGTERM outlived them: RED then GREEN);
  tables-interrupt tests hold on win32 and run on Windows CI (checked by reading and on Linux; not run on Windows).
  Independent verifier (item 5): every rule met, wasm rebuilt byte-identical, e2e-go 26/26, malicious database names
  refused, no stored value changes. Risk: item 5 (CI).
