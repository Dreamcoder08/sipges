# 0015 — Mobile-first shell

## Context
The signed-in layout (ADR 0006) grew from the legacy sidebar: on phones it became a drawer of 21
links in four equal groups under a two-row header holding a menu toggle, the title, search, a
bell, a native project `<select>`, the avatar and a "Salir" button. The owner's review
(`odd/tasks/mobile-first-redesign.md`, S1) found it reads as a compressed desktop: too many
visible choices, no frequency-based priority and a heavy navy panel.

## Decision
- **Two navigation shapes from one model.** `app/navigation.ts` stays the single source of
  screens. Above 60rem the persistent sidebar keeps the four legacy groups in menu order. At
  60rem and below a bottom bar shows five destinations — Inicio, Monitoreo, Alertas, Territorio,
  Más — and "Más" opens a sheet that groups the remaining screens by intent (Investigar,
  Gestionar, Analizar, Sistema). A unit test proves every screen is reachable exactly once on
  each shape. There is no drawer at any width.
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
