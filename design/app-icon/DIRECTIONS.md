# SIPGES — Round 2: territory + early warning

**Start with 01, Organic Terrain.** Its uneven, nested contours read most directly as mapped land. All three variations use the same idea: two terrain contours, with one amber segment separated from the inner contour. No eye, camera, crosshair, horizon, chevron or lettermark.

## 01 — Organic Terrain

`01-organic-terrain.svg` · `01-organic-terrain-mono.svg`

- **Metaphor:** two irregular elevation contours, with a small change detected along the inner terrain boundary.
- **Why SIPGES:** territorial context comes first; the warm segment expresses anticipation without presenting communities as surveillance subjects.
- **Palette:** teal-night `#0F2A2E`, ivory `#F5F2E8`, IRSA amber `#F2B544`. Ivory/background contrast: **13.48:1**; amber/background: **8.25:1**.
- **Construction:** asymmetric cubic curves, broader lower-left terrain and a narrowed upper-right shoulder. The inner boundary follows the landform without becoming a scaled circular ring.
- **Tradeoff:** the strongest geographic reading, with softer, less rigid edges than 02.

## 02 — Faceted Terrain

`02-faceted-terrain.svg` · `02-faceted-terrain-mono.svg`

- **Metaphor:** irregular surveyed terrain boundaries, with an amber facet marking an emerging change.
- **Why SIPGES:** connects mapped territory to structured assessment and commitments; the warning remains a small part of a larger context.
- **Palette:** navy `#13233A`, ivory `#F5F2E8`, IRSA amber `#F2B544`. Contrast: **14.11:1** and **8.63:1**, respectively.
- **Construction:** unequal polygon edges and asymmetric vertices, with rounded joins. Nested faceted landforms, not a regular polygon, concentric circles or a lone chevron.
- **Tradeoff:** crisper and more technical than 01; more abstract as a natural landform.

## 03 — Sheltered Terrain

`03-sheltered-terrain.svg` · `03-sheltered-terrain-mono.svg`

- **Metaphor:** terrain contours whose overall silhouette gently suggests a protective shield; an amber inner segment signals anticipation.
- **Why SIPGES:** prevention and care for territory, rather than monitoring people. The uneven shoulder keeps the outline geographical, not a symmetrical security badge.
- **Palette:** forest `#1B2B22`, ivory `#F5F2E8`, IRSA amber `#F2B544`. Contrast: **13.25:1** and **8.10:1**, respectively.
- **Construction:** an off-axis upper shoulder and tapered lower terrain; a nested, open inner contour repeats that downward flow.
- **Tradeoff:** protection is more evident, but a shield association remains possible. Choose 01 if geographical meaning must dominate completely.

## Principles applied

- **Apple HIG:** one focused idea, simple shapes, no text or photographic detail. No baked-in rounded background corners; the OS supplies its mask. [App icons](https://developer.apple.com/design/human-interface-guidelines/app-icons)
- **Material Design 3 / adaptive icons:** a shared 512-unit keyline canvas centred at (256,256), consistent **32-unit strokes**, rounded caps/joins and controlled negative space. All meaningful painted content fits inside the specified **radius-205 safe circle**. Only the full-bleed background reaches the square edges. These SVGs are concepts, not packaged Android adaptive foreground/background layers. [Material icon construction](https://m3.material.io/styles/icons/designing-icons) · [Adaptive icons](https://developer.android.com/develop/ui/views/launch/icon_design_adaptive)
- **Small-size legibility:** three glyph paths only: outer contour, inner contour and one warning segment. Three colours including the background. At 32 px the strokes are **2 px**; at 16 px they are **1 px**. The separated segment belongs to the inner contour, not a pupil or target centre. No extra terrain detail is needed.
- **Monochrome:** identical geometry, transparent background, only `currentColor`. The two breaks around the warning segment preserve its identity without colour. Use dark ink on light surfaces and white on dark surfaces, choosing host contrast of at least 3:1. An externally loaded SVG does not automatically inherit the colour of its image element; recolour through a host mask or inline SVG.
- **Wallpaper contrast:** opaque dark backgrounds preserve internal contrast on light and dark wallpapers. Both foreground colours exceed the **WCAG 3:1** graphical-object target against their own background; no claim is made about the outer plate edge against every wallpaper. [Non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)
- **Craft and restraint:** best-in-class product-icon economy, not copied silhouettes. Amber is a fixed early-warning identity accent, not an assertion of a live IRSA risk level; live status still needs labelled UI.

## Rendered verification

All six final SVGs were rendered with `rsvg-convert` at **512, 32 and 16 px**: 18 PNGs, inspected in a contact sheet with native-size small icons and nearest-neighbour enlargements. Both nested contours remain distinct at 32 px in colour and mono. At 16 px the terrain is necessarily coarser, but the two contour levels and detached segment remain visible; no additional micro-size geometry is used.

The first pass exposed sub-28-unit gaps in 01 and 02. Their outer boundaries were widened, then all sizes were rendered and inspected again. Final conservative painted-edge gap estimates from separately rendered 512 px components:

| Variation | Outer–inner | Outer–accent | Inner–accent |
| --- | ---: | ---: | ---: |
| 01 | 30.1 units | 38.1 units | 29.0 units |
| 02 | 31.2 units | 32.2 units | 33.1 units |
| 03 | 34.9 units | 36.6 units | 30.0 units |

Measurements use the 50% alpha boundary and subtract one pixel from the nearest occupied-pixel-centre distance. They are raster estimates, not exact analytic curve distances. The visible gap check and the 32 px inspection both pass.

**Structural checks:** all six parse as XML, declare `width="512"`, `height="512"` and `viewBox="0 0 512 512"`, and are **696–910 bytes** each, below 4,000 bytes. No fonts, raster images, external resources, scripts, gradients or filters. Safe-zone checks include every nonzero-alpha stroke pixel. No application code changed; behavioural RED/GREEN tests do not apply to these passive assets.

**Previews and temporary checks:** `/tmp/sipges-icon-round2-review/` (including `round2-review-v1.png`, the regenerated final contact sheet). PNGs and checking scripts are outside the deliverable directory.
