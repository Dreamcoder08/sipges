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

- T1 [ ] — S1, S2: two or three directions on the gentle-design canvas for the chat-first Inicio, at 1440 px and 390 px,
  in light and dark. Each shows the empty state, a three-turn thread with citations and a record block, an error turn
  (503) and AI off. Open question for these artboards: closure-roadmap L11 put the attention list first and the
  composer below, while S2 puts the composer at the centre. Each direction must show where «Necesita tu atención»
  lives. Route: gentle-design, owner picks. Commit: pending.
- T2 [ ] — S1, S3: chat tokens in `apps/web/src/shared/styles/tokens.css` and `design/system.md`:
  - `--measure-chat` (about 46rem) as one shared reading width, replacing Inicio's local `48rem`;
  - message rhythm (`--space-turn`), prose size and line height for answers (`--text-answer`, 1rem/1.6);
  - composer elevation (`--shadow-composer`) and radius (keep `--radius-xl`);
  - a user-bubble surface tone in both themes, contrast ≥ 4.5:1 for text and ≥ 3:1 for its border.
  Route: inline, axe in both themes. Commit: pending.
- T3 [ ] — S1, S2: a `Composer` component in `apps/web/src/shared/ui`, used by Inicio:
  - the textarea grows to 8 lines, then scrolls;
  - a «Buscar | Preguntar» segmented switch inside the composer replaces the two labelled states (disabled
    «Preguntar» with its reason when AI is off or no analyst is configured);
  - the send button becomes a stop button while an answer is pending;
  - Esc clears, ↑ in an empty composer recalls the last question, the text is kept after an error;
  - a counter appears from 450 of the 500-character limit;
  - IME-safe Enter is kept.
  Route: inline, test-first (one test per key rule). Commit: pending.
- T4 [ ] — S2: empty state from T1's chosen direction: greeting with the project name, the centred composer, and
  starter chips that send in one click (today they only fill the textarea). Chips come from the project's real
  state, for example «¿Qué alertas rojas siguen abiertas?» only when there are some. Route: inline. Commit: pending.

Phase B — the thread, client side (no backend change):

- T5 [ ] — S1, S2: a conversation thread in memory for the session:
  - each question is appended as a user turn and each answer as an assistant turn, instead of replacing the last
    answer;
  - answers keep their citations, sources and typed blocks;
  - «Nueva conversación» in the sidebar and Ctrl+Shift+O;
  - follow the bottom only while the person is at the bottom, with a «Ir al final» button otherwise;
  - each new answer is announced through `aria-live="polite"`, and motion respects reduced motion;
  - once a conversation starts, «Esta semana» folds into one line above the thread (it stays reachable), so the
    thread and the composer own the screen (L4).
  Route: inline. Commit: pending.
- T6 [ ] — S1: actions under each answer:
  - «Copiar» copies the text plus its numbered sources as plain text, with no record contents beyond what the answer
    shows;
  - «Volver a preguntar» re-sends the same question as a new turn;
  - on 409/503, «Buscar en registros» stays the fallback.
  Route: inline. Commit: pending.
- T7 [ ] — S1, S2: stop:
  - the mutation passes an `AbortSignal`, so the stop button cancels the request;
  - the turn shows «Detenido» and keeps the question for editing;
  - the Go handler already ends on a cancelled context (499): pin that with a test.
  Route: inline, test-first. Commit: pending.
- T8 [ ] — S3: a safe answer formatter: paragraphs, bold, bullet and numbered lists, `[n]` citation links, built from
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
- T10 [ ] — S2, S3: live progress:
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

- T12 [ ] — S2: on wide screens the sidebar can be hidden with a button and Ctrl+B; the choice is kept in
  `localStorage`. Hidden means gone, with the button left in the top bar, not an icon rail (S3). Route: inline.
  Commit: pending.
- T13 [ ] — S2: sidebar order:
  - «Nueva pregunta» first, with its shortcut;
  - «Buscar», showing Ctrl K;
  - then the five destinations and Integraciones;
  - then «Conversaciones» (from T11; until then, the session's questions from T5) in place of «Recientes»;
  - the project switcher and account at the bottom, with the theme switch added to the account menu.
  Route: inline. Commit: pending.
- T14 [ ] — S2: a shortcuts sheet (Ctrl+/) listing every shortcut, and the shortcut shown next to each command that
  has one. Route: inline. Commit: pending.
- T15 [ ] — S1: phones:
  - the thread fills the screen and the composer stays docked above the keyboard and the safe area;
  - the drawer holds «Nueva pregunta» and the conversations;
  - checked at 360 and 412 px with `sipges-phone-check`, no horizontal overflow.
  Route: inline. Commit: pending.

Phase E — proof:

- T16 [ ] — S1: Playwright specs (Chromium, mobile, WebKit) for the thread, stop, new conversation, AI off and the
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
