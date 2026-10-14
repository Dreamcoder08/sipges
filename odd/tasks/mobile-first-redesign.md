# Mobile-first Redesign

Turn the signed-in MASCLI web app from a desktop dashboard squeezed into a narrow screen into a mobile-native product: one task per view, the active project as the main context, few visible choices and depth on demand. Branch `claude/project-thread-ffdm3e` from `main` 06a127e. Scope is the shell only (navigation, header, account, sheets, visual system); screen contents (Dashboard, Demandas, Directorio, mapa) belong to the parallel "Auditoría y corrección integral" thread. Synthetic data only; no deployment.

## Specs
- S1: "Crea ODD, obsesivo y específico." — the owner's diagnosis (2026-10-14, project thread "Rediseño mobile-first", with a phone capture of the open drawer): no mobile-first philosophy; overloaded header (close, title, search, bell, project select, avatar, "Salir"); a long, dark, flat drawer with 11+ destinations of equal weight; weak hierarchy; navy panel that reads as a legacy intranet; navigation as a catalogue instead of a flow; no frequency-based priority.
- S2: Accepted architecture from the same message: bottom navigation Inicio · Monitoreo · Alertas · Territorio · Más; "Más" holds Actores, Directorio, Demandas, Narrativas, Inteligencia de redes, Centro gerencial and the rest; the active project dominates the header ("Sechura", "Migración") with an elegant switch; avatar opens profile, notifications and sign-out; search as a global command; "Salir" never a top-level action on mobile; soft active states (light tint, accent, semibold, icon); lighter surfaces, one accent colour reserved for selection, alerts and KPIs; controlled spacing.
- S3: Desktop must not break (coordinator brief). Keep the existing guarantees: WCAG 2.1 AA (axe clean in E2E), keyboard and screen-reader parity, CSP without inline styles from the server, no horizontal page scroll at 360 px, every screen reachable, existing E2E and unit suites green.

## Design rules (acceptance criteria for every task)
Measured at 390×844 (iPhone 14/15) and 360×780 (narrowest common Android) unless stated.
- R1 Header: one row of controls, at most three interactive elements (project context, search, account). The page title sits below it as the only `h1`. Header height ≤ 7rem with the title on one line.
- R2 Bottom bar: five destinations, 4rem tall plus `env(safe-area-inset-bottom)`; icon 1.375rem above a 0.6875rem label; every target ≥ 44×44 px; the active one carries `aria-current="page"`, the accent colour, a tinted pill behind the icon and a semibold label. Screens that live under "Más" mark "Más" as current.
- R3 Sheets (Más, Cuenta, Proyecto): bottom sheet on phones, `role="dialog"` + `aria-modal`, labelled by its title, grab handle, focus moves inside on open and back to the trigger on close, Escape and the backdrop close it, page scroll locked and content `inert` while open, max height 85dvh with internal scroll, 0.2 s slide that `prefers-reduced-motion` removes.
- R4 "Más" is organised by intent, not by org chart: Investigar, Gestionar, Analizar, Sistema; each row has an icon, label and chevron; at least 3.25rem tall.
- R5 Account: avatar (initials, unread badge) opens a sheet with name, role, active project, the notification inbox and device push switch, and "Cerrar sesión" last, styled as a quiet destructive row.
- R6 Project context: shows the project's display name (bold) and a muted secondary line; tapping opens the project sheet with the existing "Proyecto activo" selector. Never a raw `<select>` in the phone header.
- R7 Visual system: 4-pt spacing scale, one radius scale, neutral greys with a cool tint, brand navy kept only for the accent and text links, surfaces white on a light canvas, 1 px hairlines instead of filled blocks, a single soft shadow for raised layers. Contrast ≥ 4.5:1 for text, ≥ 3:1 for icons and focus rings.
- R8 Desktop (> 60rem): persistent sidebar on a light surface with icons, the same groups and soft active state; header keeps search with Ctrl K hint, bell, project selector and the account menu (without a bare "Salir" button).
- R9 Tablet (40–60rem) behaves like phones (bottom bar) so no viewport has a drawer.

## Tasks
- T1 [x] S1,S2,S3 — ADR 0015 mobile-first shell; this ODD; route: inline; commit: see L2
- T2 [ ] S2 — Navigation model: `MOBILE_TABS` (Inicio `/`, Monitoreo `/eventos`, Alertas `/alertas`, Territorio `/mapa`, Más), `MORE_GROUPS` by intent (Investigar, Gestionar with Cronología and Ubicación, Analizar, Sistema) and an icon per screen; unit test that every screen is reachable exactly once on mobile and the desktop groups still list every screen in menu order; route: inline; commit: see L3
- T3 [ ] S2,S3 — Visual tokens: spacing, radius, type scale, neutrals, accent tint, hairline, motion and safe-area tokens; light sidebar with icons and soft active state (R7, R8); route: inline; commit: see L3
- T4 [ ] S2,S3 — Sheet primitive and icon set in `shared/ui` with focus management, inert content, scroll lock and reduced motion (R3); unit tests; route: inline; commit: see L3
- T5 [ ] S1,S2 — Phone header: project context, search icon, account avatar; title row below; bell, selector and "Salir" leave the phone header (R1, R6); route: inline; commit: see L3
- T6 [ ] S1,S2 — Bottom bar and "Más" sheet replacing the drawer (R2, R4, R9); route: inline; commit: see L3
- T7 [ ] S2 — Account sheet with profile, notification inbox, device push and sign-out; unread badge on the avatar; desktop account menu without a bare "Salir" (R5, R8); route: inline; commit: see L3
- T8 [ ] S3 — Verification: unit tests, mobile E2E (bottom bar, sheets, axe with each sheet open, every screen at 360 px without horizontal scroll), desktop E2E unchanged, before/after captures through `apps/e2e/tests/screenshots.mobile.spec.ts`; route: verify; commit: see L4
- T9 [ ] S2 — "Hoy" home for phones (project, day summary, 3–5 KPIs, critical alerts, recent events, quick actions); waits for the Dashboard fixes of the "Auditoría y corrección integral" thread to merge to avoid conflicting edits; route: inline

## Log
- L1 (plan, 2026-10-14): Captured the current phone shell at 390×844 with the synthetic E2E instance: two-row header with a hamburger, title, a clipped search button, bell emoji, a native select, avatar and "Salir"; navy drawer of 21 links in four equal groups under the header. The owner's diagnosis (S1) and target architecture (S2) were accepted as the plan; screen contents stay with the parallel audit thread.
- L2 (T1 ODD y ADR): ADR 0015 (docs/adr/0015-mobile-first-shell.md) y este ODD con reglas R1–R9 y 9 tareas.
