# Chat-first Inicio and shell (inspired by ChatGPT web and Claude web)

Turn Inicio into a conversation with the analyst. The UI takes the interaction patterns of today's chat products
(a centred composer, a thread, stop and retry, a history list, a sidebar that can be hidden) and keeps SIPGES's own
rules: screens stay the source of truth, every claim cites a record, writes go through Bandeja, and the UI says when
the AI is off or down. This document continues closure-roadmap T31 (direction 01 «Calma conversacional», L11).

## Specs

- S1 — Owner (verbatim): «perfect estaba pensando en mejorar el diseño UI & Ux inspirado en chat gpt web and claude web
  usa ego-browser y mas , crea detalladamente las task que deseas implementar para mejorar mi proyecto»
- S2 — Reference observed with ego-browser on 2026-11-17, logged out on chatgpt.com and with a free account on claude.ai
  (captures in `.data/ui-refs/`, not committed):
  - The empty state is one centred question («Where should we begin?», «Let's noodle») over one large rounded
    composer. Below the composer are 1–5 one-click starter chips.
  - A left sidebar holds «New chat» first, then «Search» with its shortcut shown (Ctrl+Shift+O, Ctrl+Shift+K), then
    sections and the history («Chats and tasks»), with the account at the bottom. A button hides the sidebar.
  - The composer has a «+» menu, a mode switch inside it (Claude: «Chat | Cowork»), the model shown read-only, a send
    button, and a small disclosure line under it.
- S3 — Constraints carried over, not new requirements:
  - agentic-analyst S2–S4: citations `[n]` resolve to records, typed blocks are rendered by existing components and
    the model never emits HTML, writes are proposals that need approval.
  - closure-roadmap L11: state honesty (offline, AI off, IRSA provisional); the attention list stays visible; not to
    build: the map as the shell, the 80 px rail, loading animations for their own sake.
  - AGENTS.md: CLI first for new behaviour (`sipgesctl`, `routes.json`); synthetic data only.
- S4 — Non-goals: copying either product's name, logo, wording, colours or illustrations; voice and dictation; image
  generation; a model picker (the provider is installation configuration); file attachments in the composer (later,
  through the egress guard).

## Tasks

Phase A — design and foundations (web only):

- T1 [x] — S1, S2: two or three directions on the gentle-design canvas for the chat-first Inicio, at 1440 px and 390 px,
  in light and dark. Each shows the empty state, a three-turn thread with citations and a record block, an error turn
  (503) and AI off. Open question for these artboards: closure-roadmap L11 put the attention list first and the
  composer below, while S2 puts the composer at the centre. Each direction must show where «Necesita tu atención»
  lives. Route: gentle-design, owner picks. Done: `design/chat-first/` (three directions), decision in L6.
- T2 [x] — S1, S3: chat tokens in `apps/web/src/app/styles/tokens.css` and `design/system.md`:
  - `--measure-chat` (about 46rem) as one shared reading width, replacing Inicio's local `48rem`;
  - message rhythm (`--space-turn`), prose size and line height for answers (`--text-answer`, 1rem/1.6);
  - composer elevation (`--shadow-composer`) and radius (keep `--radius-xl`);
  - a user-bubble surface tone in both themes, contrast ≥ 4.5:1 for text and ≥ 3:1 for its border.
  Route: inline, axe in both themes. Commit: pending.
- T3 [x] — S1, S2: a `Composer` component in `apps/web/src/shared/ui`, used by Inicio:
  - the textarea grows to 8 lines, then scrolls;
  - a «Buscar | Preguntar» segmented switch inside the composer replaces the two labelled states (disabled
    «Preguntar» with its reason when AI is off or no analyst is configured);
  - the send button becomes a stop button while an answer is pending;
  - Esc clears, ↑ in an empty composer recalls the last question, the text is kept after an error;
  - a counter appears from 450 of the 500-character limit;
  - IME-safe Enter is kept.
  Route: inline, test-first (one test per key rule). Commit: pending.
- T4 [x] — S2: empty state from T1's chosen direction: greeting with the project name, the centred composer, and
  starter chips that send in one click (today they only fill the textarea). Chips come from the project's real
  state, for example «¿Qué alertas rojas siguen abiertas?» only when there are some. Route: inline. Commit: pending.

Phase B — the thread, client side (no backend change):

- T5 [x] — S1, S2: a conversation thread in memory for the session:
  - each question is appended as a user turn and each answer as an assistant turn, instead of replacing the last
    answer;
  - answers keep their citations, sources and typed blocks;
  - «Nueva conversación» in the sidebar and Ctrl+Shift+O;
  - follow the bottom only while the person is at the bottom, with a «Ir al final» button otherwise;
  - each new answer is announced through `aria-live="polite"`, and motion respects reduced motion;
  - once a conversation starts, «Esta semana» folds into one line above the thread (it stays reachable), so the
    thread and the composer own the screen (L4).
  Route: inline. Commit: pending.
- T6 [x] — S1: actions under each answer:
  - «Copiar» copies the text plus its numbered sources as plain text, with no record contents beyond what the answer
    shows;
  - «Volver a preguntar» re-sends the same question as a new turn;
  - on 409/503, «Buscar en registros» stays the fallback.
  Route: inline. Commit: pending.
- T7 [x] — S1, S2: stop:
  - the mutation passes an `AbortSignal`, so the stop button cancels the request;
  - the turn shows «Detenido» and keeps the question for editing;
  - the Go handler already ends on a cancelled context (499): pin that with a test.
  Route: inline, test-first. Commit: pending.
- T8 [x] — S3: a safe answer formatter: paragraphs, bold, bullet and numbered lists, `[n]` citation links, built from
  text nodes only (no `innerHTML`, no Markdown library, no links other than citations). Route: inline, test-first,
  including hostile input. Commit: pending.

Phase C — backend (CLI first):

- T9 [ ] — S1, S3: follow-up questions:
  - `POST /system/analyst/ask` accepts an optional `history` of earlier turns (at most 6 turns and 8,000 characters,
    question and answer text only, no blocks);
  - the history passes the egress guard like tool results;
  - CLI `sipgesctl analyst ask --follow-up <file>`, plus `routes.json` and parity with the TypeScript API if it has
    the route;
  - a reply that cites a record found only in the history must cite it again from a tool result.
  Risk: item 2 (data sent to an external model). Route: inline + independent verifier. Commit: pending.
- T10 [x] — S2, S3: live progress:
  - a streamed variant of ask (SSE, `POST /system/analyst/ask/stream`) sends `step` events naming the tool in Spanish
    («Buscando registros…», «Leyendo la línea de tiempo…»), then one `answer` event once the citations are validated,
    then `done` or `error`;
  - the answer text is not streamed token by token: markers are validated on the complete answer (agentic-analyst
    S2), and streaming would show claims that may then be rejected;
  - the CLI prints the steps.
  Risk: item 4 (a long-lived connection; cancellation). Route: inline + verifier. Commit: pending.
- T11 [ ] — S1, S2: saved conversations for a history list in the sidebar:
  - two tables, conversations and turns, scoped by project and by the person who asked, under RLS;
  - retention limit, with delete by the person;
  - routes list, get and delete, and the matching CLI;
  - real data in questions and answers is stored, so it needs an ADR and the owner's decision first (see T18).
  Risk: items 1 and 2 (migration, tenant isolation, stored real data). Route: ADR, then inline + independent verifier,
  own commit. Commit: pending.

Phase D — shell:

- T12 [x] — S2: on wide screens the sidebar can be hidden with a button and Ctrl+B; the choice is kept in
  `localStorage`. Hidden means gone, with the button left in the top bar, not an icon rail (S3). Route: inline.
  Commit: pending.
- T13 [x] — S2: sidebar order (done in T19):
  - «Nueva pregunta» first, with its shortcut;
  - «Buscar», showing Ctrl K;
  - then the five destinations and Integraciones;
  - then «Conversaciones» (from T11; until then, the session's questions from T5) in place of «Recientes»;
  - the project switcher and account at the bottom, with the theme switch added to the account menu.
  Route: inline. Commit: pending.
- T14 [x] — S2: a shortcuts sheet (Ctrl+/) listing every shortcut, and the shortcut shown next to each command that
  has one. Route: inline. Commit: pending.
- T15 [x] — S1: phones:
  - the thread fills the screen and the composer stays docked above the keyboard and the safe area;
  - the drawer holds «Nueva pregunta» and the conversations;
  - checked at 360 and 412 px with `sipges-phone-check`, no horizontal overflow.
  Route: inline. Commit: pending.

Phase E — proof:

- T19 [x] — S1, S2: build direction 01 «Centro conversacional» (`design/chat-first/01-centro-conversacional.html`),
  the owner's pick on the canvas (L10), on top of T3, T5, T12 and T14:
  - empty state: greeting and composer centred in the column, «Necesita tu atención» as at most three compact
    cards just above the composer, chips below it, and «Esta semana» as one line of links;
  - during a conversation: the thread owns the column with the composer docked at the bottom, and the urgent items
    move to a «Necesita tu atención N» button with a popover in the top bar (a bell with the count on phones). The
    count is never hidden, and the popover manages focus (Esc returns it);
  - sidebar order per T13 («Nueva pregunta» first, which starts a new conversation on Inicio; «Buscar Ctrl K»;
    destinations; «Conversaciones» with this session's questions), so T13 is done here.
  Reopens T4's layout and replaces T5's fold. Route: worker + parent. Commit: pending.
- T20 [x] — S1: move the thread, AnalystAnswer and the attention popover into a lazy chunk loaded on the first
  question, and bring the entry budget back towards 218 kB gzip (it was raised to 230 kB in L11). Route: inline.
  Commit: pending.
- T21 [x] — S2: Inicio asks through `/system/analyst/ask/stream` and shows each `step` label as the pending turn's
  progress text (fallback to `/ask` when the stream is unavailable), with the same single status announcement.
  Route: worker. Commit: pending.
- T16 [x] — S1: Playwright specs (Chromium, mobile, WebKit) for the thread, stop, new conversation, AI off and the
  503 fallback, waiting for state rather than time; axe with 0 violations in both themes; the CSS budget kept
  (41 kB) and the Inicio usable-time budget kept. Route: inline. Commit: pending.
- T17 [ ] — S1: walk-through on the owner's local install with a real model through the bridge, and the owner's
  acceptance. Route: owner + parent with ego-browser. Commit: n/a.
- T18 [ ] — S1: owner decisions:
  - (a) T1 direction;
  - (b) whether conversations are saved on the server (T11), for how long, and whether administrators may read
    them;
  - (c) whether follow-ups (T9) may send earlier answers to the external model.
  Route: owner. Commit: n/a.

Order: T1 → T2 → T3 → T4 → T5–T8 (each its own slice, about 400 lines or less) → T12–T15 → T9 → T10 → T11 after
T18(b) → T16 → T17. Phases A, B and D change no API and no stored data.

## Log
- L1 — 2026-11-17, owner (verbatim): «perfect estaba pensando en mejorar el diseño UI & Ux inspirado en chat gpt web and
  claude web usa ego-browser y mas , crea detalladamente las task que deseas implementar para mejorar mi proyecto»
- L2 — 2026-11-17, evidence:
  - References: ego-browser captures of chatgpt.com (logged out) and claude.ai/new (signed in, empty state only, no
    chats opened), at 1884×957, kept in `.data/ui-refs/` and not committed.
  - SIPGES today (read-only explorer map):
    - Inicio has a one-shot composer, «Buscar»/«Preguntar» states, IME-safe Enter and a phone dock
      (`InicioPage.tsx`, `InicioPage.module.css:30,411`).
    - Each answer replaces the last one. There is no thread, no streaming (`ask.ts:50` is one POST), no stop
      (no `AbortSignal`), no copy or retry, and no saved questions.
    - The Go analyst has no conversation route (`internal/analyst/http/routes.go`).
    - The sidebar has no collapse on wide screens (`AppShell.tsx:44,119-157`), and the theme switch lives only in
      Configuración.
    - There is no Toast and no Markdown renderer in `shared/ui`.
- L3 — 2026-11-17, decision: answer text is not streamed token by token (T10), because citation validation needs the
  whole answer. Live tool steps give the same sense of progress without showing claims that may be rejected.
- L4 — 2026-11-17, SIPGES Inicio captured with ego-browser after the owner signed in on the local install
  (Proyecto Sechura, 1884×957, `.data/ui-refs/sipges.png`):
  - The page already reads as chat-first: date and project, «Hola, Administrator», «IA externa activada», the
    «Metodología pendiente de validación» badge, «Necesita tu atención 1», then the composer («Pregunta por
    eventos, actores, demandas o compromisos…», «Preguntar, con citas», «Enter pregunta · Mayús+Enter, nueva
    línea»), four «Prueba con» chips, and «Esta semana» cards.
  - Gaps against S2:
    - the composer sits in the middle of a scrolling page, and the cards below it would push any thread away;
    - the «Inicio | Panel | Centro gerencial» tabs sit at the top left, away from the column;
    - the project is a native select above the search;
    - the sidebar cannot be hidden.
  - Signing in first showed «Seleccione un proyecto» (two projects), as expected.
- L5 — 2026-11-17, owner (verbatim): «yes te autorizo todo and continue has lo que haria gentleman + buens practicas de
  ingeneria de softwart e informacion actualizada de la web». Web research the same day (search results stored
  under `mwl1hazms40jpi`) agreed with T5–T10 and added these rules:
  - The thread is `role="log"`. A pending answer carries `aria-busy`. A status region announces the start and the end
    once each, never per update (W3C ARIA23, MDN log role, MUI X Chat accessibility, accessibility.build 2026-08).
  - «Detener» sits where «Enviar» was and keeps what was produced. The view does not follow the bottom while the
    person reads earlier text (Apple HIG Generative AI via uxpickle checklist, NN/g).
  - Progress text names the work being done («Buscando registros…»), never «Procesando…» (Apple HIG).
  - Starter chips are based on the task and send in one click (designpixil 2026-03, aiuxplayground).
  - The first visible change comes in under 400 ms: shell, progress and stop button before any content (ui-craft).
- L6 — 2026-11-17, T1 decision, taken by the parent under the owner's delegation (L5): build **02 «Atención primero»**
  with the sidebar of **01** (T12–T13: «Nueva pregunta» first, «Buscar Ctrl K», «Conversaciones», hideable). Reasons:
  - In social-conflict monitoring, an urgent item must never fall to a counter. 02 keeps «Necesita tu atención»
    visible in every state, as closure-roadmap L11 requires; 01 hides it behind a popover during a thread.
  - It is the smallest change from today's Inicio (L4) and the cheapest to build (about 10 slices against 11 and 12).
  - T5 already specifies the fold.
  - 03 «Panel lateral» narrows answers to about 55 characters and adds shell state across routes; it stays a later
    option for asking from other destinations.
  The owner can overturn this on the canvas before T4. Artboards were checked by the worker: contrast pairs all pass
  in both themes, no overflow at 390 px, targets ≥ 24 px (44 px on phones), only tokens. Proposed tokens for T2:
  `--measure-chat` 46rem, `--space-turn`, `--text-answer`, `--leading-answer` 1.6, `--color-bubble` mapped to
  `--color-fill`, and five icons (copy, retry, stop, sidebar, arrowDown). The error turn drops `role="alert"` so the
  log announces it once.
- L7 — 2026-11-17, T2 and T3 done in the `feat/chat-composer` branch by a worker, checked and committed by the parent.
  - T2, c2ca14fb: five chat tokens and five icons, with tokens.test.ts pinning their values and contrast. The
    `.home` measure hunk went into the T3 commit, which touched the same file. The bubble has no border (artboard
    02); its contrast with `--color-control-border` is pinned at 3:1 in case one is drawn later.
  - T3, 798b09b5: the `Composer` in `shared/ui` holds all seven rules, each RED first (11 failures, then green).
    The full web suite passes (816/816); typecheck, lint, build and the CSS budget pass (38.7/41 kB).
  - Behaviour changes:
    - after a successful answer the box empties, and ↑ brings the question back;
    - the «Preguntar, con citas» / «Buscar en registros de …» pill became the field's visually hidden label, and the
      switch shows the mode;
    - «Detener» calls `analyst.reset()` until T7 adds the real abort;
    - when «Preguntar» is disabled, the reason is in `aria-describedby` and the `title`.
  - Not run locally: Playwright e2e and the phone check (CI runs the e2e).
  - Slice note: 911 authored lines in two commits, past the ~400-line slice, because the composer moved out of
    Inicio with its tests; T4 onwards return to ≤ 400.
- L8 — 2026-11-17, owner (verbatim): «implementa chat-first-ui». T12 and T14 done on `feat/chat-shell` (2236a939, and
  a follow-up that keeps one `sidebar` icon after merging #511 and lists the composer's Esc and ↑). The worker left
  them uncommitted; the parent committed them.
  - T12: the sidebar hides completely (`<aside hidden>`) by button or Ctrl+B. The choice is kept in
    `sipges.sidebar`, focus is moved only when it would be lost, and the compact drawer is unchanged.
  - T14: Ctrl+/ opens «Atajos de teclado» from the single source `app/layout/shortcuts.ts`. The account menu has a
    new item, so ADR 0015 lists it.
  - Tests: RED first (SidebarToggle 4 of 5 failing, ShortcutsSheet 4 of 5 failing), then green. After the merge:
    `src/app`, `src/shared` and `src/features/dashboard` pass 343/343, and typecheck passes. The worker's full run
    on the branch: web 813/813, lint, build, CSS 38.8/41 kB.
  - Known gap: with the sidebar hidden, closing the palette (Ctrl+K) returns focus to the body, because its trigger
    is hidden.
  - Not done: a palette command «Atajos de teclado» (the menu item and Ctrl+/ cover it). Slice: 690 lines, two
    tasks sharing AppShell.
- L9 — 2026-11-17, T4 and T5 done on `feat/chat-thread` (e7f3ec5b). A worker built them; the parent approved the test
  changes outside the worker's edit surfaces and committed.
  - T4: chips send in one click (ask in «Preguntar», search in «Buscar») from `inicio/starters.ts`. «¿Qué alertas
    rojas siguen abiertas?» comes first only while a red alert is open. The order is pinned.
  - T5:
    - the thread is `role="log"` with `aria-busy`, and one hidden `role="status"` announces start, end, error and
      stop once each;
    - user bubble, «IA Analista» answers with citation anchors unique per answer (`useId`), and error turns without
      `role="alert"` (`Alert` gained `announce`, whose default is unchanged);
    - the view follows the bottom only at the bottom (sentinel and IntersectionObserver), and «Ir al final» appears
      otherwise;
    - attention and week fold into one expandable line;
    - «Nueva conversación» and Ctrl/⌘+Shift+O;
    - memory only, per project, with no storage writes.
  - Tests: RED first (T4 3 rules, T5 10 rules). The web suite passes 833/833, and typecheck, lint, build and CSS
    39.3/41 kB pass.
  - Changed by the spec: Hubs.test and e2e `25-inicio` (a chip now searches instead of filling the box),
    AnalystAnswer/inicio-ask expectations (no alert role, «Buscando registros…»).
  - Not run locally: Playwright and the phone check (CI runs the e2e).
  - Left for later:
    - the Ctrl+Shift+O entry in `shortcuts.ts`, which arrives with #512;
    - the thread is lost when leaving Inicio (T11 decides persistence);
    - «Detener» drops the pending turn until T7.
  - Slice: 1,394 lines with tests, past the slice; T6–T8 return to small units.
- L10 — 2026-11-17, owner on the canvas (verbatim): «Implement the design artboard
  design/chat-first/01-centro-conversacional.html» (handoff, with the artboard's tradeoff «A cambio, durante una
  conversación lo urgente baja a un botón con contador en la barra superior (se aparta de L11) y "Esta semana" queda
  en una línea de enlaces»). This overrides the parent's L6 choice of 02; the urgent items stay reachable through a
  counter that is always visible, which the owner accepts. Added T19, which absorbs T13. Built on
  `feat/chat-center`, stacked on #512 and #513 while their CI runs.
- L11 — 2026-11-17, owner (verbatim): «avanza mucho demoras paraleliza el trabajo y mas». T19, T13 and T15 are done on
  `feat/chat-center`, which also carries T4 and T5 (#513 is closed in its favour). Workers built them; the parent
  committed.
  - T19 (commit d30637e8): centred empty state, at most three attention cards, a one-line «Esta semana», the top-bar
    «Necesita tu atención N» panel (a bell on phones, «Nada urgente» disabled at 0), the sidebar with «Nueva
    pregunta» first and «Conversaciones», and the thread lifted into `AnalystThreadProvider` (memory only).
  - Tests: RED first (13 rules). The web suite passes 856/856.
  - The #513 CI failures had real causes:
    - the T5 fold line was 584 px wide on phones; T19 removed it, and phone specs now pin the layout;
    - the chip strip re-snapped when the red-alert chip was prepended; it is now reset before paint.
  - T15 (phones, each rule RED first):
    - greeting hidden visually during a thread, and «Nueva conversación» as a 44 px icon;
    - the composer dock keeps the safe area, and drawer targets are 44 px;
    - `interactive-widget=resizes-content` was tried and removed (2e7360eb): WebKit logs that the viewport key is
      not recognised, which fails the console-hygiene check of every WebKit e2e spec (#514 CI).
  - Playwright, run locally with the CI font: mobile-chromium 96 passed, 5 skipped; the chromium shell and Inicio
    specs 31 passed, 2 skipped. axe reports 0 violations in both themes. WebKit could not launch on this host
    (missing system libraries); CI runs it.
  - Entry budget raised on purpose to 768/230 kB (measured 731.1/218.7 kB plus 5%); T20 brings it back with a
    lazy chunk.
  - Open, for the owner:
    - the phone artboard stacks the chips while the product keeps a swipeable strip;
    - the phone tab row is cut beside the bell and «+» during a thread.
- L12 — 2026-11-17, parallel units (owner L11).
  - Web, `feat/chat-actions` d4a4aa62, stacked on #514:
    - T6: «Copiar» (text and numbered sources, one announcement, refusal shown) and «Volver a preguntar», also on
      failed turns;
    - T7 web: a real AbortSignal; «Detenido» with the question back in an empty composer; late answers dropped;
    - T8: a line-scanner formatter (paragraphs, bold, lists, `[n]`) built only from React elements, with
      hostile-input tests;
    - web 873/873, mobile and chromium Inicio specs green, entry 220.4/230 kB.
  - Go, #515 (1a83b78a):
    - T10: `POST /system/analyst/ask/stream` sends step, then answer or error, then done, plus
      `sipgesctl analyst ask --steps`;
    - T7 Go: context checks before every model and tool call;
    - the stream path was added to the read-only role gate next to `/ask` (identity, RED first);
    - independent verifier (gentle-ai-verify): no blocking findings. A1, a panic in the stream goroutine killing the
      process, was fixed RED to green. A2–A7 are follow-ups: in-stream refusals log as 200, the proposal tools show
      the generic label, `--json` shows the stream route, format characters pass `printable`, the docs omit 500,
      and `Cache-Control` is `no-store`.
    - The verifier's two durable test files were lost: the parent deleted their scratch before confirming the copy.
      The panic test was rewritten.
  - The design handoff for 01 is implemented across #514 and this branch. Added T21 (web consumes the stream).
- L13 — 2026-11-17, T21 done and T20 partly done, on `feat/chat-actions`. A worker built them; the parent committed.
  - T21: Inicio asks through `/ask/stream`, read by a TextDecoderStream SSE reader (`shared/api/sse.ts`). The
    pending turn shows the latest step label as text. There is one start and one end announcement, never one per
    step. Error events reuse `ApiError`. It falls back to `/ask` once on 404, 405 or a response that is not SSE.
    Abort stops reading. RED first: 16 rules.
  - T20: the answer view (AnalystAnswer, actions, formatter, blocks, stream client) moved to a lazy chunk, preloaded
    on composer focus or the first keypress. Entry: 736.4 → 728.1 kB raw and 220.4 → 219.2 kB gzip. It missed the
    ≤ 218 kB goal: rolldown 1.2.15 emits a shared `format-*` chunk (28.7 kB gzip) for any new dynamic import under
    Inicio, and a popover split made the entry bigger (221.2), so it was reverted. T20 stays open for a
    `vite.config.ts` chunking experiment.
  - Checks: web 893/893; Playwright mobile-chromium Inicio specs 15 passed (fallback path); chromium 25-inicio and
    performance 3 passed, 1 skipped (median 765 ms). CSS is 40.6/41 kB, close to the limit.
- L14 — 2026-11-17, T20 finished on `perf/entry-chunks`, stacked on #516.
  - One rolldown `codeSplitting` group tagged `$initial` keeps the modules index.html loads at start in the entry, so
    the shared `format-*` and `jsx-runtime-*` chunks are gone. The entry is 219.2 → 217.7 kB gzip (728.1 kB raw); all
    JS is 1,998.5 kB and CSS 40.3 kB. There are 50 files, and index.html loads one script and one stylesheet.
  - Budgets lowered to measured + 5% (765/229 kB).
  - Rejected attempts:
    - strictExecutionOrder: entry 231 kB;
    - chunkOptimization off: 218.0 kB;
    - a path-based group: 227 kB;
    - modulePreload polyfill off: only 0.2 kB, and it changes Safari < 17.
  - Checks: web 893/893; chromium 25-inicio, performance and console specs 4 passed, 1 skipped; mobile Inicio and
    analyst specs 15/15. WebKit runs in CI.
- L15 — 2026-11-17, T16 on `test/chat-e2e`. The owner's local install was updated to main 7014ee73 (`./sipges update`,
  33 migrations, health 200).
  - A worker wrote 16 Playwright tests in `40-inicio-conversation.spec.ts` (desktop, also in the WebKit list) and
    `inicio-conversation.mobile.spec.ts`:
    - a three-question thread with «Ir al final»;
    - «Detener», «Nueva conversación», Ctrl/⌘+Shift+O and «Nueva pregunta» from Registros;
    - external AI off, the 503 turn, «Copiar» with the exact clipboard text;
    - the `/ask` fallback, and live steps through a fetch-level stream;
    - Ctrl+B persisting across a reload, and Ctrl+/.
  - They found two real product bugs, fixed by the parent:
    - «Detener» resubmitted the question: the button turns back into submit before the click's default action.
      Fixed with `preventDefault` in the stop click. jsdom cannot reproduce it, so a unit test pins the behaviour and
      the e2e proves it.
    - On phones, «Buscar» from Inicio (Enter, chips, the 503 button) and Ctrl+K did nothing: the palette lived only
      in the closed drawer. AppShell now keeps a hidden palette while the drawer is closed. RED, then green, in
      AppShell.test.
  - `inicio.mobile` «chat-style home» expected the old «a chip fills the composer» behaviour; it now expects the
    palette with the chip's text (T4).
  - Checks: chromium and mobile-chromium 48/48 with `--repeat-each=2`, web 895/895, boundaries, lint, typecheck.
    WebKit runs in CI only.
- L16 — 2026-11-17, #518 CI failed only on WebKit; reproduced in Docker (`mcr.microsoft.com/playwright:v1.63.0-noble`).
  There were two causes:
  - Harness: the SPA's service worker (`/sw.js`, ADR 0014) claims the page, and then WebKit sends requests past
    `page.route`. The fakes never applied, so the composer had no «Preguntar» (a 60 s `fill` timeout) and AI-off
    showed the generic hint. Fix: `serviceWorkers: 'block'` in the conversation spec. Any WebKit-listed spec using
    `page.route` needs the same.
  - Real Safari bug: after a long answer WebKit delivered the end sentinel's «out of view» before React's passive
    follow effect ran, so the reader stayed above the new answer with «Ir al final» shown (8 of 20 runs). Fix: the
    follow runs in `useLayoutEffect`. RED, then green, in inicio-thread.test.
  - The CSP `style-src-elem inline (:5)` lines come only from WebKit's failure screenshot (as in closure-roadmap
    L32).
  - Results: WebKit in Docker 160 passed and 20 skipped over 20 repeats; the full WebKit config 43 passed and 1
    skipped; chromium and mobile 51/51; web 896/896.
- L17 — 2026-11-17, #518 merged (edcd044c) with CI green on all jobs, WebKit included. T16 is done. The owner's local
  install is updated to it. What remains: T17 (the owner's walk-through on https://localhost/inicio) and T18(b)(c), the
  owner's decisions that unblock T9 and T11.
