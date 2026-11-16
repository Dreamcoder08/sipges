/** The person asked the system for less motion; matches the reduced-motion block of global.css. */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * How a scripted scroll moves: smoothly, or at once when the person prefers reduced motion.
 * The stylesheet's `scroll-behavior: auto` does not reach `scrollIntoView({ behavior })`, so every
 * scripted smooth scroll asks here. Without `matchMedia` (jsdom) it stays smooth.
 */
export const scrollBehavior = (): ScrollBehavior =>
  window.matchMedia?.(REDUCED_MOTION_QUERY).matches ? 'auto' : 'smooth';
