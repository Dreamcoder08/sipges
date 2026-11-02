# 0018 — Design system: semantic tokens, themes and primitives

## Context
ADR 0015 gave the shell a mobile-first structure, but the screens grew their own palettes: 140
raw colours across twelve style modules (about 130), some thirty ad-hoc font sizes and three spellings of
the same status colours. Nothing could follow the device's dark mode, and each new module
copied hex values from its neighbour. The owner asked (2026-10-18) to correct the whole design
system with current senior practice and award-level mobile references.

References reviewed in October 2026: Apple Design Awards 2026 winners (Interaction and Visuals
categories favour calm, legible data screens such as Tide Guide and Moonlitt), Linear's "calmer
interface" refresh (navigation recedes, fewer borders, density kept), iOS sheets and large
titles, Material 3 segmented buttons and navigation bar, and the 2026 mobile trend reviews
(thumb-zone layouts, bottom sheets, dark mode by default, purposeful motion).

## Decision
- **Two token layers.** `app/styles/tokens.css` holds primitive scales that never change by
  theme (space, type, radius, elevation, motion, z-index, control sizes) and semantic colours
  named by role (surface, text, accent, tone, level, heat, ink, viz). Modules use semantic
  tokens only. `tokens.test.ts` rejects raw colours outside `tokens.css` and cartography paint
  in `features/geography`, which is map data, not interface chrome.
- **Light and dark themes.** The dark theme follows `prefers-color-scheme`; Configuración →
  Apariencia (`/version-4?seccion=apariencia`, the default section, open to every role) pins Sistema, Claro or Oscuro per device (`shared/lib/theme.ts`, `localStorage`, no server
  state). It is applied in `main.tsx` before the first render because the CSP forbids inline
  scripts. Both dark blocks must stay identical, which the token test checks.
- **Contrast is tested, not hoped for.** The token test computes WCAG ratios for every text pair
  the screens use (4.5:1) and for focus, accent and brand marks (3:1) in both themes, and the
  Playwright axe pass runs every screen in light and in dark.
- **Type and motion scales.** System faces (SF Pro, Segoe, Roboto) with a ten-step size ramp,
  fluid display sizes, tabular figures in tables and balanced headings. Phone screens open with
  a large title. Motion uses three durations, an iOS sheet curve and a press-in on buttons; all
  of it stops under `prefers-reduced-motion`.
- **Primitives over copies.** `Button` gains `danger` and `sm`; `Sheet` can be dragged down to
  close on phones; `QueryState` shows a skeleton under a spoken status and offers a retry;
  `EmptyState` takes an icon; `Alert` gains `warning`; `SegmentedControl` and `ChipRow` replace
  hand-made button rows (a chip row becomes one swipeable line on phones). Touch targets stay at
  44px on coarse pointers, form fields use 16px text on phones so iOS does not zoom.

## Consequences
- A new colour starts as a token with a dark value and, if it carries text, a contrast pair in
  the test. Map styling stays inside `features/geography`.
- The territorial map work in flight (ADR 0017) keeps its own files; its module is migrated to
  the tokens after it lands.
