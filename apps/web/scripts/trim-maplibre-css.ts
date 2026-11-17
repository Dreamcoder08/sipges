/**
 * MapLibre's stylesheet is mostly the icons and logo (SVG data URIs) of controls GeoCanvas never adds:
 * it turns `attributionControl` off and adds only the deck.gl overlay. Dropping those rules takes
 * about 7 kB gzip off the CSS budget (docs/testing/budgets.md, local-qa-findings T10).
 */

/** Classes of controls the map never adds, with their parts (`-inner`, `-arrow`, `-active`…). */
const UNUSED =
  /\.maplibregl-(?:ctrl-(?:logo|attrib|geolocate|fullscreen|shrink|zoom-in|zoom-out|compass|terrain|globe|scale)|compact|user-location)[\w-]*/;

/** Drops each innermost rule whose every selector names an unused control; keeps the rest as is. */
export const trimMaplibreCss = (css: string): string => {
  let dropped = 0;
  const trimmed = css.replace(/([^{}]*)\{([^{}]*)\}/g, (rule, selectors: string) => {
    const list = selectors.split(',');
    if (!list.every((selector) => UNUSED.test(selector))) return rule;
    dropped += 1;
    return '';
  });
  if (dropped === 0) {
    throw new Error(
      'maplibre-gl.css: no unused control rule found; check trim-maplibre-css.ts after an upgrade',
    );
  }
  return trimmed;
};
