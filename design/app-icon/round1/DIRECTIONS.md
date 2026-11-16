# SIPGES — three app icon directions

**Start with 03, Contour Signal:** it most directly connects territory and early warning, without becoming a mining emblem or a lettermark. All three are deliberately different ideas, not palette variations.

## 01 — Horizon

Files: `01-horizon.svg` · `01-horizon-mono.svg`

**Metaphor:** seeing what is coming over the horizon. A half-disc rises above one broad land section; the terrain is a single shallow basin, not a mountain illustration.

**Why SIPGES:** anticipation rather than emergency. The quiet, horizontal composition suits territorial teams working to prevent escalation and maintain commitments.

**Palette:** deep teal `#102D32`, warm ivory `#F5F2E8`, mineral jade `#79C8B4`. Foreground/background contrast: **12.99:1** and **7.44:1**, respectively.

**Construction:** an 80-unit-radius half-disc; a 304-unit-wide land section with 48-unit chamfers and a quadratic underside. The 40-unit sky gap becomes 1.25 px at 16 px. Both masses share the x=256 axis. Their different silhouettes remain separate when reduced to one colour.

**Principles in practice:** Apple's one focused idea; Material-style keyline geometry; two glyph shapes, three colours including the background. At 16/32 px, recognition depends on the half-disc and broad horizon, not miniature terrain detail.

**Tradeoff:** the calmest and most approachable direction, but the horizon can also suggest weather or sustainability. No rays, water lines or landscape decoration are added to explain it.

## 02 — Territorial Eye

Files: `02-territorial-eye.svg` · `02-territorial-eye-mono.svg`

**Metaphor:** a territorial lens holding one clear focus. The open centre is real negative space, not a background-coloured patch.

**Why SIPGES:** continuous situational awareness across communities, demands and commitments. The emphasis is attentive understanding, not an alarm or a literal surveillance device.

**Palette:** institutional navy `#172B48`, warm ivory `#F5F2E8`, muted brass `#DDBB72`. Foreground/background contrast: **12.71:1** and **7.74:1**.

**Construction:** mirrored cubic curves around (256,256); outer keylines x=88/424 and y=128/384; inner keylines x=152/360 and y=192/320. The optically weighted rim is 64 units thick on the principal axes. A 64-unit-diameter focus has 32 units of vertical clearance inside the aperture.

**Principles in practice:** one lens, one focus; two glyph shapes and three colours including the background. At 16 px, the main rim is 2 px on its axes, the focus is 2 px, and the narrowest axial gap is 1 px. At 32 px those dimensions double. Colour is not needed to distinguish the parts.

**Tradeoff:** the most immediately readable and institutional, but an eye may imply surveillance. Prefer another direction if that association undermines community trust.

## 03 — Contour Signal

Files: `03-contour-signal.svg` · `03-contour-signal-mono.svg`

**Metaphor:** an open territorial contour, with a signal arriving at its leading edge. A rounded diamond evokes a mapped parcel without a pin, crosshair or mountain.

**Why SIPGES:** the contour represents territorial context; the detached beacon represents noticing a change before it enters the centre of attention. The opening makes early warning part of the silhouette itself.

**Palette:** forest ink `#203831`, warm ivory `#F5F2E8`, soft amber `#F0C478`. Foreground/background contrast: **11.22:1** and **7.70:1**.

**Construction:** 45-degree contour segments, rounded quadratic turns, one consistent 56-unit stroke with round caps, and a 64-unit beacon at (352,144). Coordinates use an 8-unit grid. The asymmetric opening is intentional; no radar ticks or nested hairlines are needed.

**Principles in practice:** one contour and one beacon; two glyph shapes and three colours including the background. At 16 px, the contour is 1.75 px thick and the beacon is 2 px across; at 32 px they are 3.5 px and 4 px. The detached signal still reads without amber.

**Tradeoff:** the most ownable and product-like, but more abstract than the eye. The name and product context supply its meaning rather than extra icon detail.

## Shared design and production principles

- **Apple HIG — App icons:** one focused idea, simple silhouettes, no text, no photographic detail. Full-bleed square backgrounds have no baked-in corner radius; the OS owns the mask. [App icons](https://developer.apple.com/design/human-interface-guidelines/app-icons)
- **Material Design — geometric icon construction:** shared keylines, restrained curves and consistent stroke treatment rather than illustrative detail. These are static SVG concepts, not Android adaptive-icon layer packages. [Designing icons](https://m3.material.io/styles/icons/designing-icons)
- **Adaptive/maskable safety:** every meaningful glyph pixel, including stroke caps, fits inside the brief's circle centred at (256,256), radius 205. Observed outer radii at 512 px: Horizon **153.47**, Territorial Eye **167.51**, Contour Signal **180.11**. Only backgrounds extend beyond that circle. [Android adaptive icons](https://developer.android.com/develop/ui/views/launch/icon_design_adaptive)
- **Small-size restraint:** two glyph shapes per direction; no fine labels, thin contours or ornamental detail. SVGs were rendered at 16, 32 and 256 px for visual inspection. Mono versions retain exactly the same geometry, including real transparent holes.
- **Contrast:** every coloured glyph component exceeds WCAG's 3:1 graphical-object target against its own background. Background plates preserve this internal contrast on light and dark wallpapers; no finite palette guarantees an outer-edge contrast ratio against every possible wallpaper. [WCAG non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)
- **Monochrome use:** `*-mono.svg` files have transparent backgrounds and use only `currentColor` (black by default). Use dark ink on light surfaces and white on dark surfaces, with at least 3:1 host contrast. Inline SVG can inherit CSS colour; externally loaded SVG needs an appropriate host mask or recolouring pipeline. Do not assume an image element inherits page colour.
- **Identity, not status:** jade and amber are fixed brand accents, not live IRSA severity indicators. Actual green/yellow/orange/red risk states belong in the interface, with labels as well as colour.
- **Craft references:** the reduction and optical weight of Linear and Notion, the disciplined geometry of Figma, and the fast recognition of Apple Maps/Weather inform the restraint, not the silhouettes. No brand mark is traced or reproduced.

## Validation

All six SVGs parse as XML with Python's `xml.etree.ElementTree`, declare a `0 0 512 512` viewBox, and are below **4,000 bytes** each (therefore also below 4 KiB). They contain no fonts, raster images, scripts, external references, gradients or filters. Coloured versions have a full 512×512 background rectangle; mono versions contain only a single-colour transparent glyph.

These are passive design assets: no application code changed, and no behavioural RED/GREEN test applies. XML parsing, byte-size assertions, rendered safe-zone checks, palette contrast calculations and small-size visual inspection are the relevant checks.
