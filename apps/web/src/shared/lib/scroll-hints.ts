import { type RefObject, useEffect } from 'react';

/**
 * Edge fades of a horizontal scroller come from a scroll-driven animation in CSS
 * (modern-web-guidance scrollability-affordance-hints). Where that animation does not run (no
 * `animation-timeline: scroll()`, or reduced motion turns animations off), this sets
 * `data-more-start` / `data-more-end` while the scroller's first or last child is out of view, so
 * the stylesheet can show the same fades. Those children must be 1 px sentinels: a chip wider
 * than the scroller is never fully visible and would keep both fades on.
 */
export const useScrollHints = (ref: RefObject<HTMLElement | null>) => {
  useEffect(() => {
    const scroller = ref.current;
    if (!scroller || typeof IntersectionObserver === 'undefined') return;
    const animated =
      typeof CSS !== 'undefined' &&
      CSS.supports('animation-timeline', 'scroll()') &&
      !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const start = scroller.firstElementChild;
    const end = scroller.lastElementChild;
    if (animated || !start || !end) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const { target, isIntersecting } of entries) {
          scroller.toggleAttribute(
            target === start ? 'data-more-start' : 'data-more-end',
            !isIntersecting,
          );
        }
      },
      { root: scroller },
    );
    observer.observe(start);
    observer.observe(end);
    return () => observer.disconnect();
  }, [ref]);
};
