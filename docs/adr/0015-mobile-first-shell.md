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
  selector, the search composer («Ctrl K») with the notification bell (it opens Bandeja › «Avisos», see the
  addendum of 2026-11-02), the five destinations,
  «Integraciones» (Automatizaciones for now), «Recientes» (the last four screens or hub tabs
  opened, kept in sessionStorage for the browser tab only, never sent to the server) and, at the foot, an
  account row. There are no collapsible groups. The account menu is short, like Claude's or
  ChatGPT's: a header with the full name and username, Configuración (hint «Ctrl+,»; the shortcut
  Ctrl+, / Cmd+, opens it from anywhere except while typing), Administración, Auditoría, Ayuda y
  metodología and sign-out (menu button pattern: Enter, Space or arrows open it, arrows, Home and
  End move, Escape closes and returns focus). Automatizaciones is reached from «Integraciones»;
  the theme choice lives in Configuración → Apariencia, on phones too (the account sheet links to
  the same four screens and has no theme control). The tools are the same components as on
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

## Addendum (2026-11-01): menu drawer instead of the bottom bar

The owner asked to move the top bar icons into a mobile sidebar «asi como lo hace chat gpt mobile y claude mobile»
and chose to remove the bottom bar (`odd/tasks/mobile-drawer-shell.md`). This replaces R1–R6 above for phones and
tablets (≤ 60rem):

- The top bar holds only a menu button («Abrir menú», 44 px) and the page title (`h1`).
- The button opens the wide-screen `Sidebar` in a modal drawer from the left edge (`Sheet side="start"`): project
  selector, search, notifications, the five destinations, Integraciones, Recientes and the account menu. One
  navigation component serves every width.
- Focus moves to the current destination; Escape and the backdrop close the drawer and return focus to the button;
  navigating or switching project closes it.
- No bottom bar, no «Más» sheet and no phone-only account sheet (`AccountMenu` removed). Destinations cost one more
  tap; in exchange the content keeps the whole screen, as in ChatGPT and Claude mobile.

## Addendum (2026-11-02): notifications as «Avisos» in Bandeja

`odd/tasks/functional-closure.md` S9 moves the automation notifications (ADR 0014) out of the sidebar bell into a
Bandeja tab, «Avisos» (`/bandeja?vista=avisos`, old-style deep link `/avisos`). The bell's pop-over panel is
removed; the inbox reuses `GET /system/notifications` and `POST /system/notifications/read` unchanged.

- The owner kept the bell as a shell icon («el buzon dejalo como icono mas»): next to search in the sidebar (and so
  in the phone drawer), a link named «Notificaciones, N avisos sin leer» with the unread badge, that opens the Avisos
  tab. On phones the closed menu button keeps its dot and says «Abrir menú, N avisos sin leer».
- The device push switch lives only in Configuración › Notificaciones; the Avisos tab links to it.
