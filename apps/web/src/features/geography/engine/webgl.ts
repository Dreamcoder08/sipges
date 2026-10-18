/**
 * Whether this browser can run the MapLibre + deck.gl engine (WebGL 2). Without it, or when
 * the engine fails, the territorial map keeps the SVG renderer (ADR 0017).
 */
export const supportsWebGl2 = () => {
  if (typeof window === 'undefined' || typeof window.WebGL2RenderingContext === 'undefined')
    return false;
  try {
    return Boolean(document.createElement('canvas').getContext('webgl2'));
  } catch {
    return false;
  }
};
