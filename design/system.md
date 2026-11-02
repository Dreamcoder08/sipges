# SIPGES design system (synced for `design/compact-sidebar`)

Read-only sync of the web app's design tokens and components. Every value below was parsed from the sources named in its section; nothing is invented. The retired Python UI (`static/style.css`) was **not** used.

## Sources read

| Path | What it provides |
| --- | --- |
| `apps/web/src/app/styles/tokens.css` | All tokens: `:root` (light), `@media (prefers-color-scheme: dark)` (device dark) and `:root[data-theme='dark']` (picked dark). The two dark blocks carry identical values. |
| `apps/web/src/app/styles/global.css` | Resets, form control base, focus ring, scrollbars, reduced-motion rule |
| `apps/web/src/app/layout/AppShell.module.css` | Current sidebar, top bar and phone menu button |
| `apps/web/src/app/layout/AppShell.tsx`, `Sidebar.tsx` | Shell layout; the sidebar (`aside > nav[aria-label=Secciones]`) on wide screens and inside the phone menu drawer |
| `apps/web/src/app/navigation.ts` | `SCREENS`, `DESTINATIONS`, `SYSTEM_PATHS`, `SCREEN_ICONS` |
| `apps/web/src/shared/ui/` | Button, Badges, Card, ChipRow, SegmentedControl, Sheet, Icon, icons.ts, Field, Alert, EmptyState, Skeleton… |
| `apps/web/src/features/search/SearchPalette.module.css`, `apps/web/src/features/notifications/NotificationBell.module.css`, `apps/web/src/features/tenancy/ProjectSwitcher.module.css`, `apps/web/src/features/records/Records.module.css` | Sidebar pieces (search composer, bell, project picker) and the Eventos table / status pill |

## Token counts (from the sync)

Light `:root`: **197 tokens in 12 groups**. Dark override block: **102 tokens** (same list in the media query and in `[data-theme='dark']`; primitives such as spacing, type, radius, motion and controls never change by theme).

| Group | Light tokens | Overridden in dark |
| --- | ---: | ---: |
| Brand and text | 10 | 10 |
| Surfaces | 19 | 19 |
| Tones | 24 | 23 |
| Risk levels | 20 | 8 |
| Data visualisation | 27 | 9 |
| Cartography | 36 | 27 |
| Spacing | 10 | 0 |
| Type | 22 | 0 |
| Shape | 6 | 0 |
| Elevation | 6 | 6 |
| Motion | 6 | 0 |
| Controls and layers | 11 | 0 |
| **Total** | **197** | **102** |

Principles stated in the source (`apps/web/src/app/styles/tokens.css` header): modules use semantic tokens only; light is neutral paper; dark is true OLED black with neutral greys; primary actions are monochrome (ink on paper, inverted in dark); selection is a soft grey pill; surfaces separate by hairlines instead of shadows.

## Colors

How the theme is applied: `data-theme` on `<html>` (`light` | `dark`); with no attribute the device preference decides (`apps/web/src/app/styles/tokens.css`, `shared/lib/theme.ts` sets it).

### Brand and text (10)

Source: `apps/web/src/app/styles/tokens.css`

| Token | Light (`:root`) | Dark (`[data-theme='dark']`) | Usage |
| --- | --- | --- | --- |
| `--color-brand` | `#17365d` | `#2f6bd6` | Brand blue (map outlines, links base) |
| `--color-brand-strong` | `#0f2541` | `#2559b8` | Table header fill |
| `--color-brand-text` | `#17365d` | `#9cc0ff` | Link and ghost-button text |
| `--color-on-brand` | `#ffffff` | `#ffffff` | Text on brand fills |
| `--color-primary` | `#0d0d0d` | `#f4f4f5` | Primary action fill, brand mark (monochrome: ink on paper, inverted in dark) |
| `--color-primary-hover` | `#333333` | `#d4d4d8` | Primary hover |
| `--color-on-primary` | `#ffffff` | `#0d0d0d` | Text on primary |
| `--color-text` | `#0d0d0d` | `#ececec` | Body text |
| `--color-muted` | `#5d5d5d` | `#a3a3a3` | Secondary text, sidebar links, group labels |
| `--color-subtle` | `#6b6b6b` | `#8f8f8f` | Placeholders, counts |

### Surfaces (19)

Source: `apps/web/src/app/styles/tokens.css`

| Token | Light (`:root`) | Dark (`[data-theme='dark']`) | Usage |
| --- | --- | --- | --- |
| `--color-bg` | `#ffffff` | `#000000` | Page background |
| `--color-surface` | `#ffffff` | `#0c0c0d` | Cards, inputs, dialogs |
| `--color-surface-alt` | `#f9f9f9` | `#111113` | Footers of dialogs |
| `--color-surface-raised` | `#ffffff` | `#161618` | Search composer, sheets, popovers |
| `--color-sidebar` | `#f9f9f9` | `#000000` | Sidebar background |
| `--color-border` | `#e3e3e3` | `#2a2a2d` | Input and table borders |
| `--color-track` | `#ececec` | `#232326` | Progress tracks |
| `--color-focus` | `#0b62d6` | `#7cacf8` | Focus ring colour |
| `--color-accent` | `#0b62d6` | `#7cacf8` | Accent (selection tint source) |
| `--color-accent-tint` | `#e8f0fd` | `rgb(124 172 248 / 0.16)` | Selected option, avatar background |
| `--color-accent-text` | `#0a4aa3` | `#b5d0ff` | Text on accent tint |
| `--color-fill` | `#f4f4f4` | `#161618` | Hover fill, segmented track |
| `--color-fill-hover` | `#ececec` | `#1f1f22` | Current sidebar link pill, pressed hover |
| `--color-hairline` | `#ececec` | `#1c1c1f` | Dividers and card borders |
| `--color-hairline-strong` | `#d9d9d9` | `#323236` | Secondary button border, kbd border |
| `--color-scrim` | `rgb(0 0 0 / 0.35)` | `rgb(0 0 0 / 0.7)` | Modal backdrop |
| `--color-chrome` | `rgb(255 255 255 / 0.85)` | `rgb(0 0 0 / 0.78)` | Translucent top bar |
| `--color-scrollbar` | `rgb(0 0 0 / 0.18)` | `rgb(255 255 255 / 0.16)` | Scrollbar thumb |
| `--color-scrollbar-hover` | `rgb(0 0 0 / 0.32)` | `rgb(255 255 255 / 0.3)` |  |

### Tones (24)

Source: `apps/web/src/app/styles/tokens.css`

| Token | Light (`:root`) | Dark (`[data-theme='dark']`) | Usage |
| --- | --- | --- | --- |
| `--color-danger` | `#c53030` | `#f07178` | Destructive text |
| `--color-danger-strong` | `#8a1f1f` | `#ffb4b8` |  |
| `--color-danger-soft` | `#fdecec` | `rgb(240 113 120 / 0.14)` | Destructive hover fill |
| `--color-info` | `#2b6cb0` | `#7cacf8` |  |
| `--color-info-soft` | `#e8f1fb` | `rgb(124 172 248 / 0.14)` |  |
| `--color-success` | `#2f855a` | `#5fd39a` |  |
| `--color-success-soft` | `#e6f5ec` | `rgb(95 211 154 / 0.14)` |  |
| `--tone-positive-bg` | `#d7ebdf` | `rgb(95 211 154 / 0.16)` | Chip / pill background |
| `--tone-positive-fg` | `#195238` | `#9ee6c0` | Chip / pill text |
| `--tone-positive-solid` | `#247b55` | `#3fae7a` | Solid mark (progress fill, dots) |
| `--tone-negative-bg` | `#f7dde0` | `rgb(240 113 120 / 0.16)` | Chip / pill background |
| `--tone-negative-fg` | `#832434` | `#ffb4b8` | Chip / pill text |
| `--tone-negative-solid` | `#b03546` | `#e0606a` | Solid mark (progress fill, dots) |
| `--tone-info-bg` | `#dce7f6` | `rgb(124 172 248 / 0.16)` | Chip / pill background |
| `--tone-info-fg` | `#244e86` | `#b5d0ff` | Chip / pill text |
| `--tone-info-solid` | `#3567aa` | `#5f93e6` | Solid mark (progress fill, dots) |
| `--tone-warning-bg` | `#f8ebc6` | `rgb(240 190 90 / 0.16)` | Chip / pill background |
| `--tone-warning-fg` | `#6d4c0b` | `#f3d58f` | Chip / pill text |
| `--tone-warning-solid` | `#8a6115` | `#c99a3a` | Solid mark (progress fill, dots) |
| `--tone-neutral-bg` | `#e9edf3` | `rgb(163 163 163 / 0.14)` | Chip / pill background |
| `--tone-neutral-fg` | `#485265` | `#d4d4d4` | Chip / pill text |
| `--tone-neutral-solid` | `#68758b` | `#8f8f8f` | Solid mark (progress fill, dots) |
| `--tone-on-solid` | `#ffffff` | `#000000` | Text on solid tone marks |
| `--color-on-strong` | `#ffffff` | = light | White on risk red and dimension badges |

### Risk levels (20)

Source: `apps/web/src/app/styles/tokens.css`

| Token | Light (`:root`) | Dark (`[data-theme='dark']`) | Usage |
| --- | --- | --- | --- |
| `--level-green` | `#2f855a` | = light | Risk level solid |
| `--level-yellow` | `#d69e2e` | = light | Risk level solid |
| `--level-orange` | `#dd6b20` | = light | Risk level solid |
| `--level-red` | `#c53030` | = light | Risk level solid |
| `--level-green-soft` | `#e6f5ec` | `rgb(95 211 154 / 0.16)` | Risk level pill background |
| `--level-yellow-soft` | `#fdf6e3` | `rgb(240 190 90 / 0.16)` | Risk level pill background |
| `--level-orange-soft` | `#fdeee2` | `rgb(240 150 90 / 0.16)` | Risk level pill background |
| `--level-red-soft` | `#fdecec` | `rgb(240 113 120 / 0.16)` | Risk level pill background |
| `--level-green-text` | `#1f5c3e` | `#9ee6c0` | Risk level pill text |
| `--level-yellow-text` | `#7a5410` | `#f3d58f` | Risk level pill text |
| `--level-orange-text` | `#8a3f0d` | `#f8c29a` | Risk level pill text |
| `--level-red-text` | `#8a1f1f` | `#ffb4b8` | Risk level pill text |
| `--heat-green` | `#6fc28f` | = light | Heat-map cell fill |
| `--heat-green-on` | `#0d3520` | = light | Text on heat-map cell |
| `--heat-yellow` | `#f6d55c` | = light | Heat-map cell fill |
| `--heat-yellow-on` | `#3d2e05` | = light | Text on heat-map cell |
| `--heat-orange` | `#f4a259` | = light | Heat-map cell fill |
| `--heat-orange-on` | `#3d1a05` | = light | Text on heat-map cell |
| `--heat-red` | `#c4343d` | = light | Heat-map cell fill |
| `--heat-red-on` | `#ffffff` | = light | Text on heat-map cell |

### Data visualisation (27)

Source: `apps/web/src/app/styles/tokens.css`

| Token | Light (`:root`) | Dark (`[data-theme='dark']`) | Usage |
| --- | --- | --- | --- |
| `--dim-g` | `#2b6cb0` | = light | Dimension badge fill (G A D N E I) |
| `--dim-a` | `#6b46c1` | = light | Dimension badge fill (G A D N E I) |
| `--dim-d` | `#b7791f` | = light | Dimension badge fill (G A D N E I) |
| `--dim-n` | `#c05621` | = light | Dimension badge fill (G A D N E I) |
| `--dim-e` | `#2f855a` | = light | Dimension badge fill (G A D N E I) |
| `--dim-i` | `#4a5568` | = light | Dimension badge fill (G A D N E I) |
| `--trend-e` | `#2f9e44` | = light | Narrative trend line |
| `--trend-g` | `#6741d9` | = light | Narrative trend line |
| `--trend-d` | `#f08c00` | = light | Narrative trend line |
| `--trend-a` | `#1c7ed6` | = light | Narrative trend line |
| `--trend-n` | `#d6336c` | = light | Narrative trend line |
| `--trend-i` | `#495057` | `#a3a3a3` | Narrative trend line |
| `--viz-1` | `#2b6cb0` | = light | Categorical graph series |
| `--viz-2` | `#2f855a` | = light | Categorical graph series |
| `--viz-3` | `#dd6b20` | = light | Categorical graph series |
| `--viz-4` | `#805ad5` | = light | Categorical graph series |
| `--viz-5` | `#c53030` | = light | Categorical graph series |
| `--viz-6` | `#d69e2e` | = light | Categorical graph series |
| `--viz-7` | `#319795` | = light | Categorical graph series |
| `--viz-8` | `#5b6673` | `#8f8f8f` | Categorical graph series |
| `--ink-strong` | `#14243a` | `#ececec` | Diagram ink / canvas |
| `--ink` | `#1d2b3f` | `#d4d4d4` | Diagram ink / canvas |
| `--ink-soft` | `#5b6b84` | `#8f8f8f` | Diagram ink / canvas |
| `--ink-faint` | `#68758b` | `#7a7a7a` | Diagram ink / canvas |
| `--canvas` | `#fcfcfc` | `#050505` | Diagram ink / canvas |
| `--canvas-node` | `#f4f4f4` | `#161618` | Diagram ink / canvas |
| `--canvas-halo` | `#ffffff` | `#000000` | Diagram ink / canvas |

### Cartography (36)

Source: `apps/web/src/app/styles/tokens.css`

| Token | Light (`:root`) | Dark (`[data-theme='dark']`) | Usage |
| --- | --- | --- | --- |
| `--map-bg` | `#e9eef3` | `#0b0d10` | Map paint |
| `--map-sea` | `#d6e8f3` | `#0d1822` | Map paint |
| `--map-land` | `#f6f3ea` | `#16181b` | Map paint |
| `--map-line` | `#9aa8b4` | `#3d4652` | Map paint |
| `--map-label-sea` | `#335a73` | `#7fa3bd` | Map paint |
| `--map-label-area` | `#8a7d5c` | `#ab9f80` | Map paint |
| `--map-ink` | `#243b53` | `#c9d4df` | Map paint |
| `--map-text` | `#17212b` | `#ececec` | Map paint |
| `--map-halo` | `rgb(255 255 255 / 0.85)` | `rgb(0 0 0 / 0.8)` | Map paint |
| `--map-point` | `#ffffff` | `#16181b` | Map paint |
| `--map-concession` | `#669bb5` | `#4f8db0` | Map paint |
| `--map-selected` | `#e6b54a` | `#e6b54a` | Map paint |
| `--map-alert` | `#c34040` | `#f07178` | Map paint |
| `--map-heat-1` | `#fde7c4` | `#3a2a14` | Map paint |
| `--map-heat-2` | `#f8c27a` | `#6b4518` | Map paint |
| `--map-heat-3` | `#ee8f44` | `#a35a22` | Map paint |
| `--map-heat-4` | `#cf5a2a` | `#d0612c` | Map paint |
| `--map-outline-selected` | `#0f2541` | `#ffffff` | Map paint |
| `--map-district-line` | `#17365d` | `#c9d4df` | Map paint |
| `--map-point-halo` | `#ffffff` | `#000000` | Map paint |
| `--map-relief-1` | `#eef0e2` | `#14211a` | Map paint |
| `--map-relief-2` | `#d6e2b8` | `#27402c` | Map paint |
| `--map-relief-3` | `#e3d39c` | `#4a4a2c` | Map paint |
| `--map-relief-4` | `#c9a477` | `#5e4630` | Map paint |
| `--map-relief-5` | `#94714f` | `#7a5c44` | Map paint |
| `--map-filter-streets` | `none` | `invert(1) hue-rotate(180deg) brightness(0.92) contrast(0.88) saturate(0.6)` | Map paint |
| `--map-filter-satellite` | `none` | `brightness(0.8) saturate(0.9)` | Map paint |
| `--map-cadastre-1` | `#2f5fd0` | = light | Map paint |
| `--map-cadastre-2` | `#3a9d3a` | = light | Map paint |
| `--map-cadastre-3` | `#222222` | = light | Map paint |
| `--map-outline-imagery` | `#fffaf0` | = light | Map paint |
| `--map-marker-on` | `#ffffff` | = light | Map paint |
| `--map-marker-active` | `#17212b` | = light | Map paint |
| `--map-concession-fill` | `rgb(23 54 93 / 0.08)` | = light | Map paint |
| `--map-concession-fill-active` | `rgb(23 54 93 / 0.28)` | = light | Map paint |
| `--map-concession-fill-focus` | `rgb(43 108 176 / 0.3)` | = light | Map paint |

## Typography

Source: `apps/web/src/app/styles/tokens.css`

| Token | Value | Notes |
| --- | --- | --- |
| `--font-sans` | `system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif` |  |
| `--font-mono` | `ui-monospace, 'SF Mono', 'Cascadia Mono', 'Roboto Mono', Menlo, monospace` |  |
| `--text-2xs` | `0.625rem` | 10px |
| `--text-xs` | `0.6875rem` | 11px |
| `--text-sm` | `0.8125rem` | 13px |
| `--text-base` | `0.875rem` | 14px |
| `--text-md` | `0.9375rem` | 15px |
| `--text-body` | `1rem` | 16px |
| `--text-lg` | `1.125rem` | 18px |
| `--text-xl` | `1.375rem` | 22px |
| `--text-2xl` | `clamp(1.5rem, 1.3rem + 0.8vw, 1.875rem)` |  |
| `--text-3xl` | `clamp(1.875rem, 1.5rem + 1.6vw, 2.625rem)` |  |
| `--leading-tight` | `1.2` |  |
| `--leading-snug` | `1.35` |  |
| `--leading-normal` | `1.5` |  |
| `--tracking-tight` | `-0.015em` |  |
| `--tracking-caps` | `0.06em` |  |
| `--weight-regular` | `400` |  |
| `--weight-medium` | `500` |  |
| `--weight-semibold` | `600` |  |
| `--weight-bold` | `700` |  |
| `--weight-heavy` | `800` |  |

Applied in the shell (source `apps/web/src/app/layout/AppShell.module.css`):

| Element | Size | Weight | Other |
| --- | --- | --- | --- |
| Page title `h1` (`.heading h1`) | `--text-xl` | 700 | letter-spacing -0.015em, line-height 1.2 |
| Eyebrow (`.eyebrow`) | `--text-xs` | 600 | letter-spacing 0.04em, `--color-muted` |
| Sidebar link (`.link`) | `--text-sm` | 500 (600 when current) | `--color-muted` (current: `--color-text`) |
| Group label (`.groupLabel`) | `--text-xs` | 600 | uppercase, letter-spacing 0.06em, `--color-muted` |
| Brand name (`.brand b`) | `--text-md` | bold | letter-spacing 0.02em |
| Table cells (`.table`) | `--text-base` | 400 (header 600) | tabular figures from `apps/web/src/app/styles/global.css` |
| Card title | `--text-lg` | 600 | `--tracking-tight`; eyebrow `--text-xs` caps (`apps/web/src/shared/ui/Card.module.css`) |

Rules from `apps/web/src/app/styles/global.css`: `font-family: var(--font-sans)` on `html`; `kbd`, `code`, `pre` use `--font-mono`; headings use `text-wrap: balance`; tables, `time`, `data` use tabular numerals. No webfonts: system stacks only.

## Spacing

Source: `apps/web/src/app/styles/tokens.css` (4-pt scale)

| Token | Value | px |
| --- | --- | ---: |
| `--space-0` | `0.125rem` | 2px |
| `--space-1` | `0.25rem` | 4px |
| `--space-2` | `0.5rem` | 8px |
| `--space-3` | `0.75rem` | 12px |
| `--space-4` | `1rem` | 16px |
| `--space-5` | `1.25rem` | 20px |
| `--space-6` | `1.5rem` | 24px |
| `--space-8` | `2rem` | 32px |
| `--space-10` | `2.5rem` | 40px |
| `--space-12` | `3rem` | 48px |

Shell paddings (source `apps/web/src/app/layout/AppShell.module.css`): sidebar `--space-4` `--space-3` `--space-6`; top bar `--space-3` `--space-6`, gap `--space-4`; main `--space-6`; link `0.375rem --space-3`, gap `--space-3`; list gap 1px; groups gap `--space-5`.

## Radius

Source: `apps/web/src/app/styles/tokens.css`

| Token | Value | Typical use (source) |
| --- | --- | --- |
| `--radius-xs` | `0.1875rem` | — |
| `--radius-sm` | `0.35rem` | kbd, dimension badge |
| `--radius-md` | `0.625rem` | sidebar link, inputs, table wrap |
| `--radius-lg` | `1rem` | sheet panel, popover, account sections |
| `--radius-xl` | `1.5rem` | cards, palette dialog |
| `--radius-pill` | `999px` | buttons, chips, composer, bell |

## Shadows

Source: `apps/web/src/app/styles/tokens.css`

| Token | Light | Dark |
| --- | --- | --- |
| `--shadow-sm` | `0 1px 2px rgb(0 0 0 / 0.05)` | `0 0 0 1px rgb(255 255 255 / 0.02)` |
| `--shadow-md` | `0 8px 24px rgb(0 0 0 / 0.08)` | `0 8px 24px rgb(0 0 0 / 0.6)` |
| `--shadow-lg` | `0 20px 48px rgb(0 0 0 / 0.18)` | `0 20px 48px rgb(0 0 0 / 0.8)` |
| `--shadow-raised` | `0 -1px 0 rgb(0 0 0 / 0.03), 0 16px 48px rgb(0 0 0 / 0.16)` | `0 0 0 1px rgb(255 255 255 / 0.06), 0 -12px 40px rgb(0 0 0 / 0.8)` |
| `--shadow-chip` | `0 1px 3px rgb(0 0 0 / 0.12)` | `0 0 0 1px rgb(255 255 255 / 0.08)` |
| `--shadow-composer` | `0 0 0 1px rgb(0 0 0 / 0.06), 0 2px 12px rgb(0 0 0 / 0.06)` | `0 0 0 1px rgb(255 255 255 / 0.08)` |

Usage: `--shadow-composer` search trigger; `--shadow-raised` sheets and palette; `--shadow-md` notification panel; `--shadow-chip` small chips; dark theme replaces shadows with 1px white rings.

## Motion

Source: `apps/web/src/app/styles/tokens.css`, `apps/web/src/app/styles/global.css`

| Token | Value | Use |
| --- | --- | --- |
| `--motion-fast` | `120ms` | hover colour/background (links, buttons, composer) |
| `--motion-medium` | `220ms` | sheet fade, tab pill |
| `--motion-slow` | `360ms` | sheet rise |
| `--ease-out` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | default easing for UI state |
| `--ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` | — |
| `--ease-sheet` | `cubic-bezier(0.32, 0.72, 0, 1)` | iOS-like sheet curve |

Rule: `@media (prefers-reduced-motion: reduce)` sets `transition: none` and `animation: none` on everything (`apps/web/src/app/styles/global.css`). Pressed buttons scale to 0.98.

## Controls and layers

Source: `apps/web/src/app/styles/tokens.css`

| Token | Value | Use |
| --- | --- | --- |
| `--control-sm` | `2rem` | Small control height |
| `--control-md` | `2.5rem` | Default control height |
| `--touch-target` | `2.75rem` | Coarse-pointer minimum (WCAG 2.5.5) |
| `--focus-ring` | `3px solid var(--color-focus)` | Global :focus-visible outline (offset 2px) |
| `--z-sticky` | `20` | Stacking layer |
| `--z-popover` | `40` | Stacking layer |
| `--z-modal` | `60` | Stacking layer |
| `--z-skip` | `70` | Stacking layer |
| `--sidebar-width` | `15.5rem` | Desktop sidebar column |

## Components

Each rule names the file it comes from.

### Sidebar (current)
Source: `apps/web/src/app/layout/AppShell.tsx`, `apps/web/src/app/layout/AppShell.module.css`
- `aside` sticky, `height: 100vh`, `overflow-y: auto`, width `--sidebar-width` (15.5rem), background `--color-sidebar`, right border 1px `--color-hairline`. Scrollbar hidden until hover/focus-within.
- Brand: 2rem mark (`--color-primary` fill, `--color-on-primary` letter "S", weight 800, radius md) + "SIPGES" (`--text-md`) and "Gestión socioambiental" (`--text-xs`, muted). Sticky with a fade gradient.
- `nav[aria-label="Secciones"]`: 4 groups from `NAV_GROUPS`, always open, gap `--space-5`; each is a muted uppercase label (`aria-hidden`) over a `ul`.
- **Link** (`.link`): flex, gap `--space-3`, min-height 2.25rem, padding `0.375rem --space-3`, radius `--radius-md`, `--text-sm` weight 500, colour `--color-muted`, icon `--text-lg`. Hover (only `@media (hover: hover)`): background `--color-fill`, colour `--color-text`. **Current** (`aria-current="page"`): background `--color-fill-hover`, colour `--color-text`, weight 600.
- Resulting height: 26 links + 4 labels, so it scrolls on common laptop heights (the problem this design addresses).

### Top bar
Source: `apps/web/src/app/layout/AppShell.module.css`, `apps/web/src/app/layout/AppShell.tsx`
- Sticky, z `--z-sticky`, padding `--space-3 --space-6`, gap `--space-4`, background `--color-chrome` with `backdrop-filter: saturate(1.6) blur(14px)`, bottom border `--color-hairline`.
- Left: eyebrow (project label) over `h1`. Right (`.tools`, gap `--space-3`): search composer, bell, project switcher, account.
- Search composer (`apps/web/src/features/search/SearchPalette.module.css`): pill, min-width 13rem, height 2.5rem, background `--color-surface-raised`, shadow `--shadow-composer`, text `--color-muted` `--text-sm`, label "Buscar", `<kbd>Ctrl K</kbd>` (`--text-xs`, `--color-hairline-strong` border, `--radius-sm`). `aria-haspopup="dialog"`, `aria-keyshortcuts="Control+K Meta+K"`.
- Bell (`apps/web/src/features/notifications/NotificationBell.module.css`): 2.5rem round ghost button, icon `--text-xl`, unread badge `--level-red` / `--color-on-strong`.
- Project switcher (`apps/web/src/features/tenancy/ProjectSwitcher.module.css`): label "Proyecto activo" (`--text-xs`, 600, muted) above a native `select` (min-width 12rem, border `--color-hairline`). Label in the app: "Proyecto Sechura (Migración)".
- Account (`apps/web/src/app/layout/SidebarAccount.module.css`): row at the foot of the sidebar (also inside the phone menu drawer) with avatar, name and «Configuración y sesión»; it opens the account menu (Configuración, Administración, Auditoría, Ayuda y metodología, Cerrar sesión).

### Buttons
Source: `apps/web/src/shared/ui/Button.module.css`
Pill (`--radius-pill`), min-height `--control-md` (`sm`: `--control-sm`), `--text-base` / 600. Variants: **primary** (`--color-primary` / `--color-on-primary`, hover `--color-primary-hover`), **secondary** (`--color-surface`, border `--color-hairline-strong`), **ghost** (`--color-brand-text`), **danger**. Disabled opacity 0.55.

### Status pill and chips
Source: `apps/web/src/features/records/Records.module.css` (`.pill`), `apps/web/src/shared/ui/Badges.module.css`
- Tone pill: padding `--space-0 --space-3`, `--radius-pill`, `--text-sm`, bold; tones `positive | warning | info | negative | neutral` use `--tone-*-bg` and `--tone-*-fg`.
- Risk level pill: `--level-*-soft` / `--level-*-text` (Verde, Amarillo, Naranja, Rojo).
- Dimension badge: 1.6rem square, `--radius-sm`, `--color-on-strong`, fills `--dim-g/a/d/n/e/i` (Gobernanza, Actores, Demandas, Narrativas, Ambiental-territorial, Institucional).
- Chip row: wrap, gap `--space-2` (`apps/web/src/shared/ui/ChipRow.module.css`).

### Table
Source: `apps/web/src/features/records/Records.module.css`
`.tableWrap` border 1px `--color-border`, radius `--radius-md`; header fill `--color-brand-strong` with `--color-on-brand`, weight 600; cells padding `--space-3`, row separators `--color-border`; `--text-base`. Eventos columns in the app: Fecha, Descripción del hecho, Territorio, Dimensión principal, Verificación (levels A–E) — status uses the tone pill.

### Card
Source: `apps/web/src/shared/ui/Card.module.css`: padding `--space-5`, radius `--radius-xl`, background `--color-surface`, border 1px `--color-hairline`, optional eyebrow and title.

### Segmented control
Source: `apps/web/src/shared/ui/SegmentedControl.module.css`: track `--color-fill`, padding `--space-0`, radius `--radius-md`; options min-height `--control-md`, `--text-sm`, muted until selected.

### Sheet / popover panel
Source: `apps/web/src/shared/ui/Sheet.module.css`: background `--color-surface-raised`, `--shadow-raised`; on desktop a 23rem panel under the top bar, radius `--radius-lg`, border `--color-hairline`.

### Search palette (Ctrl K)
Source: `apps/web/src/features/search/SearchPalette.module.css`: centered dialog, width min(40rem, 100% − 2×`--space-4`), radius `--radius-xl`, `--shadow-raised`, scrim `--color-scrim`, input `--text-lg`, selected option `--color-accent-tint`, meta text `--color-muted`.

### Focus, forms and motion
Source: `apps/web/src/app/styles/global.css`: `:focus-visible { outline: var(--focus-ring); outline-offset: 2px }`; inputs padding `0.5rem 0.65rem`, border `--color-border`, radius `--radius-md`; placeholders `--color-subtle`; coarse pointers get 44px targets; reduced motion disables transitions and animations.

### Mobile navigation (context for the desktop work)
Source: `apps/web/src/app/layout/AppShell.module.css`, `apps/web/src/app/navigation.ts`
- Phones and tablets (≤ 60rem): a menu button opens the same sidebar in a drawer from the left (ADR 0015, addendum 2026-11-01); there is no bottom tab bar.

## Navigation

Source: `apps/web/src/app/navigation.ts`, icons in `apps/web/src/shared/ui/icons.ts`

**26 screens** (not 25), in 4 `NAV_GROUPS`:

| Group | Count | Screens (icon) |
| --- | ---: | --- |
| Monitoreo | 6 | Dashboard (`home`), Eventos (`pulse`), Actores (`users`), Directorio territorial (`book`), Demandas (`clipboard`), Narrativas (`message`) |
| Gestión y alertas | 8 | Centro gerencial (`gauge`), Inteligencia de redes (`network`), Alertas (`bell`), Situaciones (`layers`), Buzón (`message`), Lecciones (`layers`), Mapa territorial (`map`), Ubicación geoespacial (`pin`) |
| Análisis | 7 | Cronología (`clock`), Análisis situacional (`compass`), Inteligencia estratégica (`target`), IRSA-SIPGES (`chart`), Validación (`check`), Calidad de datos (`check`), Fuentes (`file`) |
| Sistema | 5 | Administración (`sliders`), Automatizaciones (`zap`), Metodología (`bookOpen`), Auditoría (`shield`), Configuración (`layers`) |

Icon observations: `message` is shared by Narrativas and Buzón; `layers` by Situaciones, Lecciones and Configuración; `check` by Validación and Calidad de datos. The icon set has 33 line icons on a 24-unit grid (stroke 1.75, round caps/joins, `currentColor`): home, pulse, bell, map, grid, users, book, clipboard, message, network, gauge, clock, pin, cube, compass, target, chart, check, file, sliders, zap, layers, bookOpen, shield, search, chevronRight, chevronDown, logout, close, plus, minus, landmark, briefcase.

## Derived layout values used by the sidebar explorations

These are **compositions of existing tokens**, not new tokens; they exist only inside `design/compact-sidebar/`:

| Name in artboards | Expression | Result |
| --- | --- | --- |
| `--rail` (02) | `calc(var(--space-12) + var(--space-4))` | 4rem (64px) |
| `--panel` (02) | `calc(var(--sidebar-width) - var(--space-2))` | 15rem (240px) |
| Slim sidebar (03) | `calc(var(--sidebar-width) - var(--space-2))` | 15rem |

Annotation chrome in artboards (the floating note card with the theme switch) is design tooling, not product UI; it reuses the same tokens.

## Self-check checklist

1. Every colour is `var(--…)` from the groups above; no hex or rgb outside the token block.
2. Font families are only `--font-sans` and `--font-mono`.
3. Interactive elements show `--focus-ring`; motion respects `prefers-reduced-motion`.
4. Text pairs reach WCAG AA in both themes.
