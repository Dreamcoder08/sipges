# SIPGES app icon brief

SIPGES (Sistema Inteligente de Predicción y GEStión Social) is an early-warning system for
socio-environmental risk and social conflict in mining territories (Peru). Users: territorial
management and community-relations teams. It maps territory, records communities, actors,
demands and commitments, scores risk (IRSA: green, yellow, orange, red) and raises alerts
before conflicts escalate. Tone: serious, trustworthy, calm, institutional, modern. Not a toy,
not a mining company logo, not a generic "S".

The current icon (a white serif-less "S" on navy, see ../../apps/web/public/icon.svg) is rejected
by the owner: generic, no meaning.

## What to deliver (in this directory)

Three distinct directions, each one strong metaphor, as hand-written SVG:

- `01-<name>.svg`, `02-<name>.svg`, `03-<name>.svg`: 512x512 viewBox, full-bleed square
  background (the OS applies its own corner mask), all meaningful content inside the central
  80% circle (maskable safe zone, radius 205 around 256,256).
- For each: `0N-<name>-mono.svg`, a single-colour glyph version (for favicons/notifications).
- `DIRECTIONS.md`: for each direction, the metaphor, why it fits SIPGES, palette (hex), and how
  it follows the principles below.

## Principles (follow them, cite them in DIRECTIONS.md)

- Apple Human Interface Guidelines (app icons): one focused idea, simple shapes, no text, no
  photographic detail, recognisable at small sizes.
- Material Design 3 product icons / adaptive icons: geometric construction on a keyline grid,
  consistent stroke weights, maskable safe zone.
- Legibility at 16x16 and 32x32: test mentally by removing detail; at most 3 shapes/colours.
- Works on light and dark wallpapers; sufficient contrast (WCAG 3:1 for graphical objects).
- Inspiration level: best-in-class product icons (Linear, Arc, Things, Figma, Notion, Stripe,
  Apple Maps/Weather) for craft and restraint, not to copy.
- Candidate metaphors (pick, combine or beat them): topographic contour lines (territory) with
  an early-warning pulse/signal; a map pin/territory shape with a radar sweep; a shield or eye
  formed by contour lines (vigilance); a sunrise/horizon over terrain (anticipation); risk scale
  as layered bands. Avoid: pickaxes, helmets, mountains-with-snow clichés, the letter S alone.

## Rules

- Pure SVG: no external fonts, no raster images, no scripts, no filters that blur at small size.
  Gradients allowed only if the mono version still reads.
- Valid XML; each file under 4 KB.
- Write only inside this directory.

## Round 2 feedback (owner and reviewer) — round 1 is in round1/

- 01 horizon reads as a hat/UFO; unreadable at 16 px. Rejected.
- 02 eye reads well but means surveillance: wrong message for community relations in social
  conflicts. No eyes, no cameras, no targets/crosshairs.
- 03 contour signal: the contour lines are not visible at all; it reads as a generic chevron.
- Round 2 must make TERRITORY visible: 2–4 nested, organic (not circular, not concentric
  rings) contour lines forming a recognisable terrain, with ONE early-warning accent (a point,
  a pulse or a warm band on the innermost contour) in a warm colour from the IRSA scale
  (amber #F2B544 or orange). Contours must survive at 32 px: stroke >= 28 units in the 512 grid,
  gaps >= 28 units; at 16 px the mono version may simplify to 2 contours + accent.
- Deliver three variations of THAT one concept (e.g. 01 rounded-organic, 02 geometric/angular
  faceted contours, 03 contours forming a subtle shield/territory silhouette), same file naming,
  plus DIRECTIONS.md. Background: deep, calm (#0F2A2E teal-night, #13233A navy or #1B2B22 forest).
