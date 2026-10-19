# 0019 — OLED dark theme and a conversational-app visual language

## Context
ADR 0018 introduced semantic tokens and a dark theme in blue-tinted greys. On 2026-10-19 the
owner asked for a dark palette inspired by OLED black and an interface inspired by ChatGPT and
Claude: modern, calm and current. Both products moved in 2026 towards neutral greys, a
monochrome primary action, pill controls and large radii; ChatGPT's dark theme now reaches true
black on desktop and lets people pick an accent colour, and Claude's redesign keeps a warm,
quiet palette where content, not chrome, carries colour.

## Decision
- **True black dark theme.** The page is `#000000`, so OLED screens switch those pixels off.
  Surfaces step up in neutral greys (`#0c0c0d`, `#111113`, `#161618`) and separate by
  hairlines; shadows give way to a faint light edge. The browser chrome is black as well.
- **Neutral paper in light.** White page, a `#f9f9f9` sidebar and `#ececec` hairlines, without
  the previous blue tint.
- **Monochrome primary action.** `--color-primary` is near-black ink in light and near-white in
  dark (`--color-on-primary` inverts). The navy brand stays where colour carries meaning:
  charts, map highlights and links (`--color-brand-text`). Navigation
  selection is a soft grey pill instead of an accent bar.
- **Shape.** Buttons are pills, cards and sheets use 16–24 px radii, the search field is a
  raised composer pill, the dashboard hero and sign-in use a soft accent glow on neutral ground
  instead of a solid navy slab.
- **Dark cartography.** Map paint moves to `--map-*` tokens with dark values. Street tiles are
  inverted for the dark theme (CSS filter in the SVG renderer; swapped raster brightness and a
  180° hue turn in MapLibre, which reads the theme through `useResolvedTheme`), and satellite
  imagery is only dimmed. Official legend colours (INGEMMET cadastre) stay as published.

## Consequences
- The token test now also checks primary, sidebar, raised-surface and map label pairs in both
  themes; the axe pass already runs every screen in light and dark.
- Anything WebGL draws must take its colours from `PAINT` in `GeoCanvas.tsx`, kept in step with
  the `--map-*` tokens.
