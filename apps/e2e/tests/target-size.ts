import type { Page } from '@playwright/test';

/**
 * Page measurements shared by the target-size specs: `tap-targets.mobile.spec.ts` holds a phone
 * to 44 px (WCAG 2.5.5) and `38-targets-headings.spec.ts` every screen to 24 px (WCAG 2.2 SC
 * 2.5.8). Not a spec itself, so Playwright never collects it as one.
 */

/**
 * Controls smaller than `min` px, as `tag «name» (w×h)`; links inside running text are exempt.
 * `equivalentSvg` also exempts nodes drawn inside an SVG chart or map (the actor map's cards):
 * WCAG 2.5.8's «equivalent» exception, since every such node is also listed with a full-size
 * control on the same screen (the records list, «Registros en el mapa»).
 */
export const smallTargets = (page: Page, min: number, { equivalentSvg = false } = {}) =>
  page.evaluate(
    async ({ min, equivalentSvg }) => {
      // Entrance animations scale controls for a moment; measure the settled layout. Endless
      // ones (skeleton shimmer, spinners) never finish, so they are not waited for.
      await Promise.all(
        document
          .getAnimations()
          .filter((animation) =>
            Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)),
          )
          .map((animation) => animation.finished.catch(() => undefined)),
      );
      const selector =
        'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="tab"], [role="option"], [role="switch"], [role="checkbox"], [role="radio"]';
      // A stretched link (`::after` with `inset: 0`) is as large as its positioned card or row.
      const targetBox = (element: Element) => {
        const after = getComputedStyle(element, '::after');
        const parent = element instanceof HTMLElement ? element.offsetParent : null;
        return after.position === 'absolute' && after.content !== 'none' && parent
          ? parent.getBoundingClientRect()
          : element.getBoundingClientRect();
      };
      // In a sentence: other text around it, in a text element or as an inline box in any other.
      const inText = (element: Element) =>
        element.tagName === 'A' &&
        (['P', 'LI', 'DD', 'TD', 'SPAN', 'SMALL'].includes(element.parentElement?.tagName ?? '') ||
          getComputedStyle(element).display === 'inline') &&
        (element.parentElement?.textContent ?? '').trim() !== (element.textContent ?? '').trim();
      return [...document.querySelectorAll(selector)]
        .filter((element) => {
          const box = targetBox(element);
          const style = getComputedStyle(element);
          if (box.width === 0 || box.height === 0) return false;
          // Parked above the page until focused (the skip link): keyboard only, never tapped.
          if (box.bottom <= 0) return false;
          if (style.visibility === 'hidden' || style.display === 'none') return false;
          // A native input inside its label is sized by the label (checkbox and radio rows).
          if (element.closest('label') && element.tagName === 'INPUT') {
            const label = element.closest('label')?.getBoundingClientRect();
            if (label && label.height >= min) return false;
          }
          if (element.closest('[aria-hidden="true"], [inert]')) return false;
          if (equivalentSvg && element.closest('svg')) return false;
          if (inText(element)) return false;
          return box.height < min - 0.5 || box.width < min - 0.5;
        })
        .map((element) => {
          const box = targetBox(element);
          const name =
            element.getAttribute('aria-label') ??
            (element.textContent ?? '').trim().slice(0, 40) ??
            element.tagName;
          return `${element.tagName.toLowerCase()} «${name}» (${Math.round(box.width)}×${Math.round(box.height)})`;
        });
    },
    { min, equivalentSvg },
  );

/**
 * Headings that skip a level after the one before them in reading order (`h2 → h4 «text»`), as a
 * screen reader's heading list shows them: hidden subtrees out, visually hidden headings in.
 */
export const headingSkips = (page: Page) =>
  page.evaluate(() => {
    const headings = [
      ...document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]'),
    ].filter(
      (element) => element.checkVisibility() && !element.closest('[aria-hidden="true"], [inert]'),
    );
    const levelOf = (element: Element) =>
      element.getAttribute('role') === 'heading'
        ? Number(element.getAttribute('aria-level') ?? 2)
        : Number(element.tagName.slice(1));
    const skips: string[] = [];
    let previous = 0;
    for (const heading of headings) {
      const level = levelOf(heading);
      if (previous > 0 && level > previous + 1)
        skips.push(`h${previous} → h${level} «${(heading.textContent ?? '').trim().slice(0, 40)}»`);
      previous = level;
    }
    return skips;
  });
