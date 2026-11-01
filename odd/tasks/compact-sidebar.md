# Compact sidebar (design 01, collapsible focus)

The desktop sidebar lists all 26 screens in four always-open groups, so it scrolls and feels long.
Implement the chosen design direction in the real stack.

## Specs

- S1 — «hay algo que quiero que corrijas el sidebar se ve muy largo inspirate en el sidebar de chat gpt , claude y mas sorftwart de vanguardia de esta semana , mes de octubre 2026 enfocado en el buen diseño Ui & Ux»
- S2 — Chosen option, verbatim: «01 + Ctrl K (recomendada)» — «Fijados arriba y un solo grupo abierto, como Claude o ChatGPT. Mantiene las etiquetas y tus 4 grupos, así no hay que aprender nada nuevo. Saco el duplicado y Sistema pasa al menú del avatar.»
- S3 — Visual spec: `design/compact-sidebar/01-collapsible-focus.html` (tokens in `design/system.md`). The duplicate seen in the artboard (Dashboard and Eventos both under «Fijados» and inside Monitoreo) must not appear: a pinned screen is not repeated in its group.
- S4 — At 1440×900 the desktop sidebar fits without scrolling.
- S5 — «tambien elimina la redundancia se supone que ya todo debe estar en el sidebar y ya no en la parte de arriba» (screenshot of the top bar: search «Buscar Ctrl K», notification bell with count, «Proyecto activo» picker, avatar «AS Administración SIPGES»). On wide screens these live only in the sidebar; the top bar keeps the page eyebrow and title (and page actions). On compact screens, which have no sidebar, the top bar keeps them.
- S6 — «el theme debe ir dentro de configuracion inspirate en claude» (screenshots: today's account menu with Sistema screens and a Tema group; Claude's menu: email header, Settings with a shortcut, Usage, Language, Get help, Log out). The account menu becomes short like Claude's; the theme choice moves into Configuración.
- S7 — «he aqui otra referencia , [Claude Settings: Account, Billing, Usage, Appearance, Your Claude, Capabilities, Notifications, Privacy, Wellbeing, Customize, Code; Account shows profile and where you're logged in] entonces las notificaiones deben estar dentro de settings ?» Answer given: notification preferences go in Configuración; the feed of pending items belongs in Bandeja, which absorbs the bell (one place for what needs attention).

## Tasks

- T1 — S1–S4: sidebar with a search button that opens the existing Ctrl K palette, «Fijados», collapsible groups (only the current page's group open; the person can open others), and an account menu at the bottom holding the Sistema screens and the theme choice; tests and docs. Route: delegated worker. Commit: pending.
- T1 also covers S5 (scope addition before T1 closed).
- T2 — S4, S5: check in the running app against the artboard. Route: inline. Commit: n/a.
- T3 — S6: short account menu (identity header, Configuración with shortcut, Administración, Auditoría, Ayuda y metodología, Cerrar sesión; Automatizaciones removed because Integraciones already reaches it) and an «Apariencia» section in Configuración. Route: delegated worker. Commit: pending.
- T4 — S7: Configuración as one settings screen with a section nav (Cuenta with active sessions and «cerrar sesión en todos», Apariencia, Notificaciones preferences, Privacidad y datos with the external-AI switch, Proyecto for admins, link to Integraciones); the bell merges into Bandeja. Route: after T3 and odd/tasks/ai-egress-privacy.md T1 land (they edit the same page). Commit: pending.

## Log

- L1 — S1 and S2 verbatim above. Design `design/compact-sidebar/` has three artboards; 01 chosen, 02 (rail and flyout) and 03 (command-first) are alternatives.
- L2 — S5 verbatim above, added while T1 was in progress.
- L3 — T1 implemented (S1–S5), not yet committed or closed. Sidebar: `app/layout/Sidebar.tsx`, `SidebarAccount.tsx`, `NavLink.tsx`; `PINNED_PATHS`, `SIDEBAR_SECTIONS`, `SYSTEM_PATHS`, `groupLabelFor` in `app/navigation.ts`. Search, bell and project select are the existing slots rendered in the sidebar on wide screens (top bar keeps eyebrow + title); compact layout unchanged. RED: `AppShell.test.tsx` 18 of 19 failed (the compact check passed), `navigation.test.ts` 2 failed. GREEN: web 72 files / 352 tests pass; lint, typecheck, boundaries, web build exit 0; Playwright chromium 06, 07, 19, 22, 23, 01, 03, 10, 18 and mobile-chromium `mobile.spec.ts` pass. Screenshots: `design/compact-sidebar/.screenshots/implemented-{light,dark}.png`. Tests outside `app/layout` re-pointed with the owner's approval: `App.test.tsx` (3 desktop tests: sign-out, Auditoría, SIPGES screens).
- L4 — Parent review: implemented 1440×900 screenshot (`design/compact-sidebar/.screenshots/implemented-light.png`) matches the chosen artboard: Fijados, one open group, project/search/bell in the sidebar, account at the bottom, top bar title only. Checks reported green by the worker: web 352/352, lint, typecheck, boundaries, build, Playwright 23/22/07/06/19/03/10/01/18 and mobile.
- L5 — S6 verbatim. Parent finding: «Automatizaciones» appeared twice (account menu and sidebar «Integraciones», same /automatizaciones).
- L6 — S7 verbatim; sequencing decided by the parent to avoid three writers on SettingsPage.tsx.

- L7 — T3 implemented (S6), not yet committed or closed. Desktop menu (`SidebarAccount.tsx`): header with full name and username; Configuración (hint «Ctrl+,», `aria-keyshortcuts`, Ctrl+, / Cmd+, registered globally and ignored in input, textarea, select and contenteditable), Administración, Auditoría, Ayuda y metodología (→ /metodologia), divider, Cerrar sesión; no Automatizaciones, no Tema. New `features/situations/AppearanceSection.tsx` (radio group «Tema» Sistema/Claro/Oscuro with the existing `theme.ts` helpers, per-device note) rendered above the project settings in `SettingsPage.tsx` for every role. Phone account sheet (`AccountMenu.tsx`): theme control removed, `links` slot with the same four screens (filled by `router.tsx`). RED: `AppShell.test.tsx` 7 failed, `SettingsPage.test.tsx` 1 failed, `AppearanceSection.test.tsx` could not load. GREEN: web 74 files / 367 tests pass; lint, boundaries, typecheck, web build and e2e typecheck exit 0; Playwright chromium 06, 07 (light and dark), 22, 23 pass (9 passed, 1 screenshot test skipped); mobile-chromium `mobile.spec.ts` passes alone in 57.9s (60s test limit; one earlier run timed out at 60s with the other mobile specs before it). Docs: ADR 0015, ADR 0018, CHANGELOG. `SidebarAccount` keeps an unused optional `projectLabel` prop until `Sidebar.tsx` stops passing it.
