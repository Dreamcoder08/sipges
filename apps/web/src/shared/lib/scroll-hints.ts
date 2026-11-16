import { type RefObject, useEffect } from 'react';
import { REDUCED_MOTION_QUERY } from './motion.ts';

/**
 * Edge fades of a horizontal scroller come from a scroll-driven animation in CSS
 * (modern-web-guidance scrollability-affordance-hints). Where that animation does not run (no
 * `animation-timeline: scroll()`, or reduced motion turns animations off), this sets
 * `data-more-start` / `data-more-end` while the scroller's first or last child is out of view, so
 * the stylesheet can show the same fades. Those children must be 1 px sentinels: a chip wider
 * than the scroller is never fully visible and would keep both fades on.
 */
export const useScrollHints = (
  ref: RefObject<HTMLElement | null>,
  /**
   * `always`: set the attributes in every browser, for hints drawn from them alone
   * (shared/ui/ScrollCues.module.css), not from a scroll-driven animation.
   */
  { always = false }: { always?: boolean } = {},
) => {
  useEffect(() => {
    const scroller = ref.current;
    if (!scroller || typeof IntersectionObserver === 'undefined') return;
    const animated =
      !always &&
      typeof CSS !== 'undefined' &&
      CSS.supports('animation-timeline', 'scroll()') &&
      !window.matchMedia?.(REDUCED_MOTION_QUERY).matches;
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
  }, [ref, always]);
};
