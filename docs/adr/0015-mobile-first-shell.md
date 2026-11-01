# 0015 — Mobile-first shell

## Context
The signed-in layout (ADR 0006) grew from the legacy sidebar: on phones it became a drawer of 21
links in four equal groups under a two-row header holding a menu toggle, the title, search, a
bell, a native project `<select>`, the avatar and a "Salir" button. The owner's review
(`odd/tasks/mobile-first-redesign.md`, S1) found it reads as a compressed desktop: too many
visible choices, no frequency-based priority and a heavy navy panel.

## Decision
- **Two navigation shapes from one model.** `app/navigation.ts` stays the single source of
  screens and of the five destinations (`odd/tasks/workspace-architecture.md`, S3). Above 60rem
  the persistent sidebar is compact (see below). At 60rem and below a bottom bar shows four
  destinations — Inicio, Registros, Bandeja, Territorio — and Más; "Más" opens a sheet with
  Análisis and the Sistema screens. A unit test proves every screen is reachable from the bar,
  the sheet or a hub tab on each shape. There is no drawer at any width.
- **Five hubs, old routes intact.** `/inicio`, `/registros`, `/territorio`, `/bandeja` and
  `/analisis` render today's screens as tabs, chosen by `?tipo=` (Registros) or `?vista=` in the
  URL (zod-validated; an unknown value shows the first tab), so tabs are linkable and back/forward
  works. The old routes keep working as deep links, with no redirects until a later task replaces
  a screen. A destination is current on its hub and on the old screens it absorbs. No data,
  permission or API change.
- **Compact sidebar above 60rem** (`odd/tasks/compact-sidebar.md`, S1–S5). It holds every tool of
  the shell, so the top bar keeps the project eyebrow and the title only: brand, the project
  selector, the search composer («Ctrl K») with the notification bell, the five destinations,
  «Integraciones» (Automatizaciones for now), «Recientes» (the last four screens or hub tabs
  opened, kept in sessionStorage for the browser tab only, never sent to the server) and, at the foot, an
  account row. There are no collapsible groups. The Sistema screens, the appearance choice and
  sign-out live in the account menu (menu button pattern: Enter, Space or arrows open it, arrows,
  Home and End move, Escape closes and returns focus). The tools are the same components as on
  phones (`search`, `notifications`, `projectSwitcher` slots), so labels and requests do not
  change; the phone layout is untouched. Only the navigation scrolls.
- **Context before chrome.** The phone header holds only the project context, search and the
  account avatar; the screen title is the `h1` under it. The project selector, notification
  inbox and sign-out move into sheets. The selector keeps its accessible name ("Proyecto
  activo") so tests and assistive technology find it the same way.
- **One sheet primitive.** `shared/ui/Sheet.tsx` implements modal bottom sheets (focus in and
  back, Escape, backdrop, scroll lock, inert content, reduced motion). The shell renders either
  the desktop or the phone variant of a control, never both, so labels stay unique.
- **Composition stays in the app layer.** Features expose pieces (`ProjectSwitcher`,
  `AccountMenu`, `NotificationInbox`, `useUnreadNotifications`); `app/router.tsx` wires them,
  so features still never import each other (ADR 0002).
- **Visual system.** Tokens add a 4-pt spacing scale, type and radius scales, cool neutrals, an
  accent tint for selection, hairlines, motion and safe-area insets. Surfaces are light; navy is
  the accent, not a panel colour. Icons are inline SVG drawn with `currentColor`, no runtime
  dependency.

## Consequences
- Viewport-dependent rendering uses `matchMedia`; without it (jsdom, old browsers) the desktop
  shape renders, which keeps existing unit tests meaningful. Phone behaviour is covered by unit
  tests that stub `matchMedia` and by the Playwright `mobile-chromium` project.
- Screen contents are unchanged by this decision; a phone "Hoy" home is a follow-up task.

## References
Apple Human Interface Guidelines (tab bars, sheets), Material 3 (navigation bar, bottom sheets),
WAI-ARIA Authoring Practices (dialog modal), WCAG 2.2 (2.5.8 target size, 2.4.11 focus not
obscured).
