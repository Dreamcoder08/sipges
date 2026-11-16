import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

/**
 * WCAG 2.2 AA, the level every screen is held to. Axe tags select rules by the version that
 * introduced them, not cumulatively, so the 2.0 and 2.1 A/AA tags stay listed beside `wcag22aa`.
 */
export const WCAG_22_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * Waits for every running animation that ends (a sheet sliding in, a menu fading in) to finish.
 * Endless ones (skeleton shimmer, spinners) are left alone.
 */
export const settleAnimations = (page: Page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.playState === 'running' &&
            Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)),
        )
        .map((animation) => animation.finished.catch(() => undefined)),
    ).then(() => undefined),
  );

/**
 * Axe over the page as it rests. `toBeVisible()` already holds at opacity 0, and axe blends
 * opacity into the text colour, so a check run during a fade-in reports contrast the user never
 * sees at rest: CI on main measured the account menu's muted text as #7c7c7c (4.17:1) halfway
 * through its 220 ms `pop`. Settling first measures the colours WCAG judges.
 */
export const analyzeAccessibility = async (page: Page, tags: string[] = WCAG_22_AA) => {
  await settleAnimations(page);
  return new AxeBuilder({ page }).withTags(tags).analyze();
};
