# SIPGES design system

Read-only sync of the web app on `main` (commit `a5825d36`, 2026-11-12) for `odd/tasks/closure-roadmap.md` T28 step 1.
Every value below was parsed from the source file named in its section; nothing is invented. Proposals that are
not yet in the source live only in the artboards under `design/vanguard/` and are marked there as «Tokens nuevos».

**Not a source:** `reference/python/static/style.css` is the legacy Python prototype. It is the behavioural reference
only and was not read for this sync; none of its colours, sizes or components belong to the current product.

## Sources read

| Path | What it provides |
| --- | --- |
| `apps/web/src/app/styles/tokens.css` | Every token: `:root` (light), `@media (prefers-color-scheme: dark) :root:not([data-theme='light'])` (device dark) and `:root[data-theme='dark']` (chosen dark). The two dark blocks carry identical values (102 declarations each). |
| `apps/web/src/app/styles/global.css` | Reset, form control base, focus ring, scrollbars, tabular figures, coarse-pointer targets, reduced-motion rule |
| `apps/web/src/shared/ui/**` | 19 components: Alert, Badges, BarList, Button, Card, charts/Charts, ChipRow, ConfirmDialog, dialog, EmptyState, Field, graph/ForceGraph, Icon (with `icons.ts`), NarrativeCharts, QueryState, SegmentedControl, Sheet, Skeleton, time/TimeHistogram; helpers `account-name.ts`, `time/series.ts` |

Theme switch: `data-theme` on `<html>` (`light` | `dark`); with no attribute the device preference decides.
Header principles in `tokens.css`: modules use semantic tokens only (a unit test rejects raw colours); light is
neutral paper; dark is OLED black with neutral greys; primary actions are monochrome.

## Token counts

Light `:root`: **195 tokens in 12 groups**. Each dark block overrides **102**. Primitive scales
(spacing, type, shape, motion, controls) never change by theme. The previous sync (2026-11-06) counted 197; the
source holds 195 (Controls and layers has 9 tokens, not 11).

| Group | Light | Overridden in dark |
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
| Controls and layers | 9 | 0 |
| **Total** | **195** | **102** |

`--topbar-height` is read by `global.css` (`scroll-padding-top`) with a `0px` fallback; AppShell sets it at run time.
It is not declared in `tokens.css`.

## Colors

### Brand and text (10)

Source: `apps/web/src/app/styles/tokens.css`

| Token | Light | Dark | Uses in CSS | Usage |
| --- | --- | --- | ---: | --- |
| `--color-brand` | `#17365d` | `#2f6bd6` | 19 | Brand blue: chart bars and lines, histogram selection |
| `--color-brand-strong` | `#0f2541` | `#2559b8` | 3 | Histogram focus fill |
| `--color-brand-text` | `#17365d` | `#9cc0ff` | 16 | Links (`a` in global.css), ghost button text |
| `--color-on-brand` | `#ffffff` | `#ffffff` | 2 | Text on brand fills |
| `--color-primary` | `#0d0d0d` | `#f4f4f5` | 8 | Primary button fill: monochrome, ink on paper, inverted in dark |
| `--color-primary-hover` | `#333333` | `#d4d4d8` | 3 | Primary button hover |
| `--color-on-primary` | `#ffffff` | `#0d0d0d` | 8 | Text on primary |
| `--color-text` | `#0d0d0d` | `#ececec` | 44 | Body text (`html` in global.css) |
| `--color-muted` | `#5d5d5d` | `#a3a3a3` | 152 | Secondary text, hints, chart ticks |
| `--color-subtle` | `#6b6b6b` | `#8f8f8f` | 3 | Placeholders |

### Surfaces (19)

Source: `apps/web/src/app/styles/tokens.css`

| Token | Light | Dark | Uses in CSS | Usage |
| --- | --- | --- | ---: | --- |
| `--color-bg` | `#ffffff` | `#000000` | 4 | Page background |
| `--color-surface` | `#ffffff` | `#0c0c0d` | 51 | Inputs, cards, secondary button, dialog |
| `--color-surface-alt` | `#f9f9f9` | `#111113` | 16 | Empty state, graph background |
| `--color-surface-raised` | `#ffffff` | `#161618` | 10 | Sheet panel, selected segment |
| `--color-sidebar` | `#f9f9f9` | `#000000` | 1 | Sidebar background |
| `--color-border` | `#e3e3e3` | `#2a2a2d` | 72 | Input border (global.css), chart axis, danger button border. 1.28:1 on white |
| `--color-track` | `#ececec` | `#232326` | 10 | Progress and bar tracks, spinner track |
| `--color-focus` | `#0b62d6` | `#7cacf8` | 10 | Focus ring colour |
| `--color-accent` | `#0b62d6` | `#7cacf8` | 10 | Checkbox/radio accent, spinner, empty-state icon |
| `--color-accent-tint` | `#e8f0fd` | `rgb(124 172 248 / 0.16)` | 11 | Selection background (`::selection`), empty-state icon disc |
| `--color-accent-text` | `#0a4aa3` | `#b5d0ff` | 6 | Selection text |
| `--color-fill` | `#f4f4f4` | `#161618` | 25 | Hover fill, segmented track, disabled input, sheet close |
| `--color-fill-hover` | `#ececec` | `#1f1f22` | 9 | Pressed or current fill |
| `--color-hairline` | `#ececec` | `#1c1c1f` | 27 | Card border, desktop sheet border |
| `--color-hairline-strong` | `#d9d9d9` | `#323236` | 17 | Secondary button border, empty-state dashed border, sheet handle. 1.41:1 on white |
| `--color-scrim` | `rgb(0 0 0 / 0.35)` | `rgb(0 0 0 / 0.7)` | 6 | Modal and sheet backdrop |
| `--color-chrome` | `rgb(255 255 255 / 0.85)` | `rgb(0 0 0 / 0.78)` | 2 | Translucent top bar |
| `--color-scrollbar` | `rgb(0 0 0 / 0.18)` | `rgb(255 255 255 / 0.16)` | 3 | Scrollbar thumb |
| `--color-scrollbar-hover` | `rgb(0 0 0 / 0.32)` | `rgb(255 255 255 / 0.3)` | 1 | Scrollbar thumb under the pointer |

### Tones (24)

Source: `apps/web/src/app/styles/tokens.css`

| Token | Light | Dark | Uses in CSS | Usage |
| --- | --- | --- | ---: | --- |
| `--color-danger` | `#c53030` | `#f07178` | 10 | Danger button text, invalid input border |
| `--color-danger-strong` | `#8a1f1f` | `#ffb4b8` | 4 |  |
| `--color-danger-soft` | `#fdecec` | `rgb(240 113 120 / 0.14)` | 4 | Danger button hover |
| `--color-info` | `#2b6cb0` | `#7cacf8` | 3 |  |
| `--color-info-soft` | `#e8f1fb` | `rgb(124 172 248 / 0.14)` | 3 |  |
| `--color-success` | `#2f855a` | `#5fd39a` | 3 |  |
| `--color-success-soft` | `#e6f5ec` | `rgb(95 211 154 / 0.14)` | 1 |  |
| `--tone-positive-bg` | `#d7ebdf` | `rgb(95 211 154 / 0.16)` | 6 | Alert and pill background |
| `--tone-positive-fg` | `#195238` | `#9ee6c0` | 6 | Alert and pill text |
| `--tone-positive-solid` | `#247b55` | `#3fae7a` | 5 | Alert border, solid mark |
| `--tone-negative-bg` | `#f7dde0` | `rgb(240 113 120 / 0.16)` | 5 | Alert and pill background |
| `--tone-negative-fg` | `#832434` | `#ffb4b8` | 5 | Alert and pill text |
| `--tone-negative-solid` | `#b03546` | `#e0606a` | 5 | Alert border, solid mark |
| `--tone-info-bg` | `#dce7f6` | `rgb(124 172 248 / 0.16)` | 7 | Alert and pill background |
| `--tone-info-fg` | `#244e86` | `#b5d0ff` | 7 | Alert and pill text |
| `--tone-info-solid` | `#3567aa` | `#5f93e6` | 5 | Alert border, solid mark |
| `--tone-warning-bg` | `#f8ebc6` | `rgb(240 190 90 / 0.16)` | 8 | Alert and pill background |
| `--tone-warning-fg` | `#6d4c0b` | `#f3d58f` | 8 | Alert and pill text |
| `--tone-warning-solid` | `#8a6115` | `#c99a3a` | 5 | Alert border, solid mark |
| `--tone-neutral-bg` | `#e9edf3` | `rgb(163 163 163 / 0.14)` | 7 | Alert and pill background |
| `--tone-neutral-fg` | `#485265` | `#d4d4d4` | 7 | Alert and pill text |
| `--tone-neutral-solid` | `#68758b` | `#8f8f8f` | 1 | Alert border, solid mark |
| `--tone-on-solid` | `#ffffff` | `#000000` | 0 | Text on solid tone marks |
| `--color-on-strong` | `#ffffff` | = light | 4 | White on risk red and dimension badges |

### Risk levels (20)

Source: `apps/web/src/app/styles/tokens.css`

| Token | Light | Dark | Uses in CSS | Usage |
| --- | --- | --- | ---: | --- |
| `--level-green` | `#2f855a` | = light | 5 | Risk level solid (BarList, Charts) |
| `--level-yellow` | `#d69e2e` | = light | 5 | Risk level solid; as a bar fill it is 2.39:1 on white |
| `--level-orange` | `#dd6b20` | = light | 6 | Risk level solid (BarList, Charts) |
| `--level-red` | `#c53030` | = light | 8 | Risk level solid (BarList, Charts) |
| `--level-green-soft` | `#e6f5ec` | `rgb(95 211 154 / 0.16)` | 3 | Level pill background (Badges) |
| `--level-yellow-soft` | `#fdf6e3` | `rgb(240 190 90 / 0.16)` | 2 | Level pill background (Badges) |
| `--level-orange-soft` | `#fdeee2` | `rgb(240 150 90 / 0.16)` | 3 | Level pill background (Badges) |
| `--level-red-soft` | `#fdecec` | `rgb(240 113 120 / 0.16)` | 3 | Level pill background (Badges) |
| `--level-green-text` | `#1f5c3e` | `#9ee6c0` | 3 | Level pill text (Badges) |
| `--level-yellow-text` | `#7a5410` | `#f3d58f` | 2 | Level pill text (Badges) |
| `--level-orange-text` | `#8a3f0d` | `#f8c29a` | 3 | Level pill text (Badges) |
| `--level-red-text` | `#8a1f1f` | `#ffb4b8` | 5 | Level pill text (Badges) |
| `--heat-green` | `#6fc28f` | = light | 1 | Heat-map cell fill |
| `--heat-green-on` | `#0d3520` | = light | 1 | Text on the heat cell |
| `--heat-yellow` | `#f6d55c` | = light | 1 | Heat-map cell fill |
| `--heat-yellow-on` | `#3d2e05` | = light | 1 | Text on the heat cell |
| `--heat-orange` | `#f4a259` | = light | 1 | Heat-map cell fill |
| `--heat-orange-on` | `#3d1a05` | = light | 1 | Text on the heat cell |
| `--heat-red` | `#c4343d` | = light | 1 | Heat-map cell fill |
| `--heat-red-on` | `#ffffff` | = light | 1 | Text on the heat cell |

### Data visualisation (27)

Source: `apps/web/src/app/styles/tokens.css`

| Token | Light | Dark | Uses in CSS | Usage |
| --- | --- | --- | ---: | --- |
| `--dim-g` | `#2b6cb0` | = light | 5 | Dimension badge fill (G A D N E I) |
| `--dim-a` | `#6b46c1` | = light | 5 | Dimension badge fill (G A D N E I) |
| `--dim-d` | `#b7791f` | = light | 5 | Dimension badge fill; white text on it is 3.64:1 |
| `--dim-n` | `#c05621` | = light | 5 | Dimension badge fill (G A D N E I) |
| `--dim-e` | `#2f855a` | = light | 5 | Dimension badge fill (G A D N E I) |
| `--dim-i` | `#4a5568` | = light | 5 | Dimension badge fill (G A D N E I) |
| `--trend-e` | `#2f9e44` | = light | 3 | Narrative trend line |
| `--trend-g` | `#6741d9` | = light | 3 | Narrative trend line |
| `--trend-d` | `#f08c00` | = light | 3 | Narrative trend line |
| `--trend-a` | `#1c7ed6` | = light | 3 | Narrative trend line |
| `--trend-n` | `#d6336c` | = light | 3 | Narrative trend line |
| `--trend-i` | `#495057` | `#a3a3a3` | 3 | Narrative trend line |
| `--viz-1` | `#2b6cb0` | = light | 1 | Categorical series (ForceGraph) |
| `--viz-2` | `#2f855a` | = light | 1 | Categorical series (ForceGraph) |
| `--viz-3` | `#dd6b20` | = light | 1 | Categorical series (ForceGraph) |
| `--viz-4` | `#805ad5` | = light | 1 | Categorical series (ForceGraph) |
| `--viz-5` | `#c53030` | = light | 1 | Categorical series (ForceGraph) |
| `--viz-6` | `#d69e2e` | = light | 1 | Categorical series 6; 2.39:1 on white |
| `--viz-7` | `#319795` | = light | 1 | Categorical series (ForceGraph) |
| `--viz-8` | `#5b6673` | `#8f8f8f` | 1 | Categorical series (ForceGraph) |
| `--ink-strong` | `#14243a` | `#ececec` | 1 | Diagram ink and canvas |
| `--ink` | `#1d2b3f` | `#d4d4d4` | 2 | Diagram ink and canvas |
| `--ink-soft` | `#5b6b84` | `#8f8f8f` | 2 | Diagram ink and canvas |
| `--ink-faint` | `#68758b` | `#7a7a7a` | 2 | Diagram ink; dark value is 4.21:1 on #161618 |
| `--canvas` | `#fcfcfc` | `#050505` | 2 | Diagram ink and canvas |
| `--canvas-node` | `#f4f4f4` | `#161618` | 0 | Diagram ink and canvas |
| `--canvas-halo` | `#ffffff` | `#000000` | 2 | Diagram ink and canvas |

### Cartography (36)

Source: `apps/web/src/app/styles/tokens.css`

| Token | Light | Dark | Uses in CSS | Usage |
| --- | --- | --- | ---: | --- |
| `--map-bg` | `#e9eef3` | `#0b0d10` | 1 | Map paint |
| `--map-sea` | `#d6e8f3` | `#0d1822` | 2 | Map paint |
| `--map-land` | `#f6f3ea` | `#16181b` | 3 | Map paint |
| `--map-line` | `#9aa8b4` | `#3d4652` | 1 | Map paint |
| `--map-label-sea` | `#335a73` | `#7fa3bd` | 1 | Map paint |
| `--map-label-area` | `#8a7d5c` | `#ab9f80` | 1 | Map paint |
| `--map-ink` | `#243b53` | `#c9d4df` | 7 | Map paint |
| `--map-text` | `#17212b` | `#ececec` | 3 | Map paint |
| `--map-halo` | `rgb(255 255 255 / 0.85)` | `rgb(0 0 0 / 0.8)` | 1 | Map paint |
| `--map-point` | `#ffffff` | `#16181b` | 2 | Map paint |
| `--map-concession` | `#669bb5` | `#4f8db0` | 2 | Map paint |
| `--map-selected` | `#e6b54a` | `#e6b54a` | 2 | Map paint |
| `--map-alert` | `#c34040` | `#f07178` | 1 | Map paint |
| `--map-heat-1` | `#fde7c4` | `#3a2a14` | 1 | Map paint |
| `--map-heat-2` | `#f8c27a` | `#6b4518` | 1 | Map paint |
| `--map-heat-3` | `#ee8f44` | `#a35a22` | 1 | Map paint |
| `--map-heat-4` | `#cf5a2a` | `#d0612c` | 1 | Map paint |
| `--map-outline-selected` | `#0f2541` | `#ffffff` | 0 | Map paint |
| `--map-district-line` | `#17365d` | `#c9d4df` | 0 | Map paint |
| `--map-point-halo` | `#ffffff` | `#000000` | 0 | Map paint |
| `--map-relief-1` | `#eef0e2` | `#14211a` | 0 | Map paint |
| `--map-relief-2` | `#d6e2b8` | `#27402c` | 0 | Map paint |
| `--map-relief-3` | `#e3d39c` | `#4a4a2c` | 0 | Map paint |
| `--map-relief-4` | `#c9a477` | `#5e4630` | 0 | Map paint |
| `--map-relief-5` | `#94714f` | `#7a5c44` | 0 | Map paint |
| `--map-filter-streets` | `none` | `invert(1) hue-rotate(180deg) brightness(0.92) contrast(0.88) saturate(0.6)` | 1 | Map paint |
| `--map-filter-satellite` | `none` | `brightness(0.8) saturate(0.9)` | 1 | Map paint |
| `--map-cadastre-1` | `#2f5fd0` | = light | 1 | Map paint |
| `--map-cadastre-2` | `#3a9d3a` | = light | 1 | Map paint |
| `--map-cadastre-3` | `#222222` | = light | 1 | Map paint |
| `--map-outline-imagery` | `#fffaf0` | = light | 1 | Map paint |
| `--map-marker-on` | `#ffffff` | = light | 2 | Map paint |
| `--map-marker-active` | `#17212b` | = light | 1 | Map paint |
| `--map-concession-fill` | `rgb(23 54 93 / 0.08)` | = light | 1 | Map paint |
| `--map-concession-fill-active` | `rgb(23 54 93 / 0.28)` | = light | 1 | Map paint |
| `--map-concession-fill-focus` | `rgb(43 108 176 / 0.3)` | = light | 1 | Map paint |

«Uses in CSS» counts `var(--token)` occurrences across `apps/web/src/**/*.css` on this commit.

## Typography

Source: `apps/web/src/app/styles/tokens.css`

| Token | Value | px |
| --- | --- | ---: |
| `--font-sans` | `system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif` |  |
| `--font-mono` | `ui-monospace, 'SF Mono', 'Cascadia Mono', 'Roboto Mono', Menlo, monospace` |  |
| `--text-2xs` | `0.625rem` | 10 |
| `--text-xs` | `0.6875rem` | 11 |
| `--text-sm` | `0.8125rem` | 13 |
| `--text-base` | `0.875rem` | 14 |
| `--text-md` | `0.9375rem` | 15 |
| `--text-body` | `1rem` | 16 |
| `--text-lg` | `1.125rem` | 18 |
| `--text-xl` | `1.375rem` | 22 |
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

Rules in `apps/web/src/app/styles/global.css`: `html` uses `--font-sans`, `--color-text`, `--leading-normal`;
`code, kbd, pre, samp` use `--font-mono`; `h1–h4` use `text-wrap: balance`, `p` uses `text-wrap: pretty`;
`table, time, data` use tabular numerals; on coarse pointers form fields get `font-size: max(1rem, 1em)` so iOS
does not zoom. No webfonts: system stacks only (SF Pro on Apple, Segoe UI on Windows, Roboto on Android).

Literal sizes in `shared/ui` (not tokens): `charts/Charts.module.css` ticks and values `11px`, radar label `12px`,
donut total `26px`; `graph/ForceGraph.module.css` edge label `10px`, node label `11px`; `Button.module.css` icon `1.125em`.

## Spacing

Source: `apps/web/src/app/styles/tokens.css` (4-pt scale)

| Token | Value | px |
| --- | --- | ---: |
| `--space-0` | `0.125rem` | 2 |
| `--space-1` | `0.25rem` | 4 |
| `--space-2` | `0.5rem` | 8 |
| `--space-3` | `0.75rem` | 12 |
| `--space-4` | `1rem` | 16 |
| `--space-5` | `1.25rem` | 20 |
| `--space-6` | `1.5rem` | 24 |
| `--space-8` | `2rem` | 32 |
| `--space-10` | `2.5rem` | 40 |
| `--space-12` | `3rem` | 48 |

Literal in `global.css`: inputs pad `0.5rem 0.65rem`. Breakpoints used in `shared/ui`: `40rem` (Card, ChipRow,
ConfirmDialog), `60.01rem` (Sheet: panel instead of bottom sheet), `28rem` (Charts donut).

## Radius

Source: `apps/web/src/app/styles/tokens.css`

| Token | Value | Used by (shared/ui) |
| --- | --- | --- |
| `--radius-xs` | `0.1875rem` | Skeleton line |
| `--radius-sm` | `0.35rem` | Dimension badge |
| `--radius-md` | `0.625rem` | Inputs, Alert, SegmentedControl track |
| `--radius-lg` | `1rem` | EmptyState, ConfirmDialog, desktop Sheet panel |
| `--radius-xl` | `1.5rem` | Card, Sheet (bottom sheet and drawer corners) |
| `--radius-pill` | `999px` | Button, level pill, sheet handle and close, scrollbar thumb |

Literal radii in `shared/ui`: `999px` in `BarList.module.css` (track) and `charts/Charts.module.css` (`.round`);
`50%` in EmptyState icon and QueryState spinner; `3px` chart swatch.

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

Used in `shared/ui`: `--shadow-raised` Sheet panel; `--shadow-lg` ConfirmDialog; `--shadow-sm` selected segment.
Dark replaces drop shadows with 1px white rings.

## Motion

Source: `apps/web/src/app/styles/tokens.css`, `apps/web/src/app/styles/global.css`

| Token | Value | Used by (shared/ui) |
| --- | --- | --- |
| `--motion-fast` | `120ms` | Button and segment colour, input border |
| `--motion-medium` | `220ms` | Sheet backdrop fade, sheet drag release |
| `--motion-slow` | `360ms` | Sheet rise |
| `--ease-out` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | Button, segment, backdrop |
| `--ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` | Skeleton shimmer |
| `--ease-sheet` | `cubic-bezier(0.32, 0.72, 0, 1)` | Sheet rise and drag (iOS sheet curve) |

Literal durations: `QueryState.module.css` spinner `0.8s linear infinite`; `Skeleton.module.css` shimmer `1.4s`.
`global.css` under `prefers-reduced-motion: reduce` sets `transition: none`, `animation: none` and
`scroll-behavior: auto` on every element. Pressed buttons scale to `0.98`.

## Controls and layers

Source: `apps/web/src/app/styles/tokens.css`

| Token | Value |
| --- | --- |
| `--control-sm` | `2rem` |
| `--control-md` | `2.5rem` |
| `--touch-target` | `2.75rem` |
| `--focus-ring` | `3px solid var(--color-focus)` |
| `--z-sticky` | `20` |
| `--z-popover` | `40` |
| `--z-modal` | `60` |
| `--z-skip` | `70` |
| `--sidebar-width` | `15.5rem` |

`ConfirmDialog.module.css` stacks its backdrop at `z-index: 100` and dialog at `101`, above `--z-modal` (60) and
`--z-skip` (70); `Sheet.module.css` uses `--z-modal`.

## Components (`apps/web/src/shared/ui`)

Each rule names its file. Feature folders hold further one-off variants (see the T28 audit); only the shared
primitives are the system.

- **Button** (`Button.module.css`): pill `--radius-pill`, min-height `--control-md` (`sm`: `--control-sm`, pad
  `--space-1 --space-3`, `--text-sm`), pad `--space-2 --space-4`, `--text-base` / `--weight-semibold`, gap `--space-2`.
  Variants: **primary** `--color-primary` / `--color-on-primary`, hover `--color-primary-hover`; **secondary**
  `--color-surface`, border `--color-hairline-strong`, hover `--color-fill`; **ghost** transparent, text
  `--color-brand-text`, hover `--color-fill`; **danger** `--color-surface`, border `--color-border`, text
  `--color-danger`, hover border `--color-danger` and fill `--color-danger-soft`. Active `scale(0.98)`; disabled
  opacity `0.55`; coarse pointer min-height `--touch-target`.
- **Alert** (`Alert.module.css`, `Alert.tsx`): tones `error | warning | info | success` → `--tone-negative|warning|info|positive`
  `-bg` fill, `-solid` 1px border, `-fg` text; pad `--space-2 --space-3`, `--radius-md`, `--text-base`. `error` is
  `role="alert"`, the rest `role="status"`.
- **DimensionBadge** (`Badges.module.css`): `<abbr>` 1.6rem square, `--radius-sm`, `--weight-heavy` `--text-sm`,
  `--color-on-strong` on `--dim-g|a|d|n|e|i`; `title` carries the dimension name.
- **LevelPill** (`Badges.module.css`): pill, pad `--space-0 --space-3`, `--weight-bold` `--text-sm`; Verde,
  Amarillo, Naranja, Rojo → `--level-*-soft` / `--level-*-text`; label from the project settings (ADR 0020).
- **BarList** (`BarList.module.css`): `dl` rows, label column `minmax(6.5rem, 11rem)`, 0.6rem track `--color-track`,
  fill `--color-brand` or level / dimension solids.
- **Card** (`Card.module.css`): pad `--space-5` (`--space-4` under 40rem), `--radius-xl`, `--color-surface`, 1px
  `--color-hairline`; eyebrow `--text-xs` caps `--tracking-caps` `--color-muted`; title `--text-lg` semibold.
- **ChipRow** (`ChipRow.module.css`, `ChipRow.tsx`): `role="group"`, wraps with gap `--space-2`; under 40rem one
  swipeable line with scroll snap that bleeds to the edges; it scrolls the `aria-pressed="true"` chip into view.
- **SegmentedControl** (`SegmentedControl.module.css`): fieldset; track `--color-fill` `--radius-md` pad `--space-0`;
  option min-height `--control-md`, `--text-sm` medium `--color-muted`; checked `--color-surface-raised`,
  `--color-text`, semibold, `--shadow-sm`; focus ring on the hidden radio.
- **Field** (`Field.module.css`): grid gap `--space-1`; label semibold `--text-base`; hint `--text-sm` `--color-muted`.
- **EmptyState** (`EmptyState.module.css`, `EmptyState.tsx`): centred, pad `--space-8 --space-4`, 1px dashed
  `--color-hairline-strong`, `--radius-lg`, `--color-surface-alt`; optional icon in a `--touch-target` disc
  (`--color-accent-tint` / `--color-accent`); title `--text-md` semibold; text `--color-muted`; optional `action`.
- **QueryState** (`QueryState.tsx`): loading = spoken status «Cargando …» with a 1rem spinner plus Skeleton; error =
  Alert `error` plus a secondary small «Reintentar» button when the query can refetch.
- **Skeleton** (`Skeleton.module.css`): 0.875rem lines on `--color-fill`, widths 92/78/58%, shimmer 1.4s.
- **Sheet** (`Sheet.module.css`): layer `--z-modal`; phones: bottom sheet `--radius-xl` top corners, max 36rem wide,
  85dvh, grabber 2.25rem × 0.3125rem, rise `--motion-slow` `--ease-sheet`, drag follows the finger; ≥ 60.01rem:
  a 23rem panel under the top bar's right edge, `--radius-lg`, 1px `--color-hairline`, no scrim; `data-side="start"`
  is the navigation drawer, `min(20rem, 86vw)`, full height. Close button is a `--touch-target` circle on `--color-fill`.
- **ConfirmDialog** (`ConfirmDialog.module.css`, `dialog.tsx` from shadcn/ui New York v4 over Radix): centred,
  `min(100% − 2×--space-4, 32rem)`, pad `--space-6`, `--radius-lg`, `--shadow-lg`; under 40rem a bottom sheet with
  full-width actions. z-index 100/101.
- **Charts** (`charts/Charts.module.css`): axis `--color-border`, grid `--color-track`, ticks `--color-muted` 11px,
  bars and lines `--color-brand`, level and trend classes, donut with legend; `.sinNivel` uses `--color-muted`.
- **ForceGraph** (`graph/ForceGraph.module.css`): `--color-surface-alt` canvas, `--color-border` frame, edges
  `--color-muted`, nodes `--viz-1…8`, focus stroke `--color-focus`.
- **TimeHistogram** (`time/TimeHistogram.module.css`): 4rem bars `--color-border`, hover `--color-muted`, selected
  `--color-brand`, focus `--color-brand-strong` with `--color-focus` stroke.
- **Focus and forms** (`global.css`): `:focus-visible { outline: var(--focus-ring); outline-offset: 2px }`; inputs
  1px `--color-border`, `--radius-md`, `--color-surface`; invalid → `--color-danger` border; disabled →
  `--color-fill` / `--color-muted`; checkbox, radio, range and progress use `--color-accent`; coarse pointers get
  `--touch-target` field height.

## Icons (43)

Source: `apps/web/src/shared/ui/icons.ts`, `Icon.tsx`. Line icons on a 24-unit grid, stroke 1.75, round caps and
joins, `currentColor`, `aria-hidden`; the control that holds one carries the accessible name.

`home`, `pulse`, `bell`, `map`, `grid`, `users`, `book`, `clipboard`, `message`, `network`, `gauge`, `clock`, `pin`, `cube`, `compass`, `target`, `chart`, `check`, `file`, `sliders`, `zap`, `layers`, `bookOpen`, `shield`, `search`, `chevronRight`, `chevronDown`, `logout`, `close`, `menu`, `plus`, `minus`, `landmark`, `inbox`, `alert`, `trend`, `chevronLeft`, `plug`, `briefcase`, `arrowUp`, `link`, `mail`, `lightbulb`.

## Contrast notes (computed from the values above, WCAG 2.x relative luminance)

| Pair | Ratio | Need |
| --- | ---: | ---: |
| `--color-border` #e3e3e3 on white (input edge) | 1.28 | 3:1 |
| `--color-hairline-strong` #d9d9d9 on white (secondary button edge) | 1.41 | 3:1 |
| dark `--color-border` #2a2a2d on `--color-surface` #0c0c0d | 1.37 | 3:1 |
| dark `--color-hairline-strong` #323236 on #0c0c0d | 1.53 | 3:1 |
| white on `--dim-d` #b7791f | 3.64 | 4.5:1 |
| `--level-yellow` / `--viz-6` #d69e2e on white (mark) | 2.39 | 3:1 |
| dark `--ink-faint` #7a7a7a on `--canvas-node` #161618 (text) | 4.21 | 4.5:1 |
| `--map-concession` #669bb5 on `--map-land` #f6f3ea (outline) | 2.73 | 3:1 |
| `--color-muted` #5d5d5d on white / dark #a3a3a3 on #000 | 6.58 / 8.33 | 4.5:1 |
| `--color-subtle` #6b6b6b on `--color-fill` #f4f4f4 | 4.85 | 4.5:1 |
| every `--tone-*-fg` on its `--tone-*-bg` (light) | 6.58–7.30 | 4.5:1 |
| every `--level-*-text` on its `--level-*-soft` (light) | 6.27–8.01 | 4.5:1 |

## Self-check checklist (for every artboard)

1. Every colour is `var(--…)` from the groups above, or a «Tokens nuevos» proposal declared on the artboard with
   its value and contrast; no hex or rgb outside the token blocks.
2. Font families are only `--font-sans` and `--font-mono`.
3. Interactive elements show `--focus-ring`; selection is distinct from focus; motion respects
   `prefers-reduced-motion`.
4. Text pairs reach 4.5:1 and control edges and data marks 3:1 in both themes.
