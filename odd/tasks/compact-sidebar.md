# Compact sidebar (design 01, collapsible focus)

The desktop sidebar lists all 26 screens in four always-open groups, so it scrolls and feels long.
Implement the chosen design direction in the real stack.

## Specs

- S1 — «hay algo que quiero que corrijas el sidebar se ve muy largo inspirate en el sidebar de chat gpt , claude y mas sorftwart de vanguardia de esta semana , mes de octubre 2026 enfocado en el buen diseño Ui & Ux»
- S2 — Chosen option, verbatim: «01 + Ctrl K (recomendada)» — «Fijados arriba y un solo grupo abierto, como Claude o ChatGPT. Mantiene las etiquetas y tus 4 grupos, así no hay que aprender nada nuevo. Saco el duplicado y Sistema pasa al menú del avatar.»
- S3 — Visual spec: `design/compact-sidebar/01-collapsible-focus.html` (tokens in `design/system.md`). The duplicate seen in the artboard (Dashboard and Eventos both under «Fijados» and inside Monitoreo) must not appear: a pinned screen is not repeated in its group.
- S4 — At 1440×900 the desktop sidebar fits without scrolling.
- S5 — «tambien elimina la redundancia se supone que ya todo debe estar en el sidebar y ya no en la parte de arriba» (screenshot of the top bar: search «Buscar Ctrl K», notification bell with count, «Proyecto activo» picker, avatar «AS Administración SIPGES»). On wide screens these live only in the sidebar; the top bar keeps the page eyebrow and title (and page actions). On compact screens, which have no sidebar, the top bar keeps them.

## Tasks

- T1 — S1–S4: sidebar with a search button that opens the existing Ctrl K palette, «Fijados», collapsible groups (only the current page's group open; the person can open others), and an account menu at the bottom holding the Sistema screens and the theme choice; tests and docs. Route: delegated worker. Commit: pending.
- T1 also covers S5 (scope addition before T1 closed).
- T2 — S4, S5: check in the running app against the artboard. Route: inline. Commit: n/a.

## Log

- L1 — S1 and S2 verbatim above. Design `design/compact-sidebar/` has three artboards; 01 chosen, 02 (rail and flyout) and 03 (command-first) are alternatives.
- L2 — S5 verbatim above, added while T1 was in progress.
- L3 — T1 implemented (S1–S5), not yet committed or closed. Sidebar: `app/layout/Sidebar.tsx`, `SidebarAccount.tsx`, `NavLink.tsx`; `PINNED_PATHS`, `SIDEBAR_SECTIONS`, `SYSTEM_PATHS`, `groupLabelFor` in `app/navigation.ts`. Search, bell and project select are the existing slots rendered in the sidebar on wide screens (top bar keeps eyebrow + title); compact layout unchanged. RED: `AppShell.test.tsx` 18 of 19 failed (the compact check passed), `navigation.test.ts` 2 failed. GREEN: web 72 files / 352 tests pass; lint, typecheck, boundaries, web build exit 0; Playwright chromium 06, 07, 19, 22, 23, 01, 03, 10, 18 and mobile-chromium `mobile.spec.ts` pass. Screenshots: `design/compact-sidebar/.screenshots/implemented-{light,dark}.png`. Tests outside `app/layout` re-pointed with the owner's approval: `App.test.tsx` (3 desktop tests: sign-out, Auditoría, SIPGES screens).
- L4 — Parent review: implemented 1440×900 screenshot (`design/compact-sidebar/.screenshots/implemented-light.png`) matches the chosen artboard: Fijados, one open group, project/search/bell in the sidebar, account at the bottom, top bar title only. Checks reported green by the worker: web 352/352, lint, typecheck, boundaries, build, Playwright 23/22/07/06/19/03/10/01/18 and mobile.

