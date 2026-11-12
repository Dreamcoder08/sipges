import type { Page } from '@playwright/test';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';
import { watchNetwork } from '../support/network.ts';

/**
 * Tap targets on a phone (closure-roadmap T18): on the seven destinations at 360 px, every
 * visible control of the shell and the page is at least 44 px tall and wide (WCAG 2.5.5), except
 * links inside running text, which WCAG exempts. Set SIPGES_E2E_SCREENSHOT_DIR to also save one
 * capture per destination and theme for the owner's review.
 */
const DESTINATIONS = [
  ['inicio', '/inicio'],
  ['registros', '/registros'],
  ['bandeja', '/bandeja'],
  ['territorio', '/territorio'],
  ['analisis', '/analisis'],
  ['integraciones', '/integraciones'],
  ['configuracion', '/version-4'],
] as const;
const MIN = 44;
const dir = process.env.SIPGES_E2E_SCREENSHOT_DIR;

/** Controls smaller than the minimum, as `name (w×h)`; inline text links are exempt. */
const smallTargets = (page: Page) =>
  page.evaluate(async (min) => {
    // Entrance animations scale controls for a moment; measure the settled layout.
    await Promise.all(document.getAnimations().map((animation) => animation.finished));
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
    const inText = (element: Element) =>
      element.tagName === 'A' &&
      ['P', 'LI', 'DD', 'TD', 'SPAN', 'SMALL'].includes(element.parentElement?.tagName ?? '') &&
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
  }, MIN);

for (const colorScheme of ['light', 'dark'] as const) {
  test(`every control of the seven destinations is a 44 px tap target (${colorScheme})`, async ({
    page,
    admin,
    adminApi,
  }) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 360, height: 800 });
    const stamp = `${colorScheme}-${Date.now()}`;
    const actorName = `Colectivo táctil ${stamp}`;
    const created = await adminApi.post('/api/actores', {
      headers: { 'X-SIPGES-Scope': DEFAULT_SCOPE },
      data: {
        payload: {
          ID_Actor: `A-TAP-${stamp}`,
          'Nombre_Actor/Organizacion': actorName,
          Posicion_Proyecto: 'En contra',
          Territorio: 'Vice',
        },
      },
    });
    expect(created.status(), await created.text()).toBe(200);
    await signInToProject(page, admin, DEFAULT_SCOPE);
    const settled = watchNetwork(page);
    const found: Record<string, string[]> = {};
    for (const [name, href] of DESTINATIONS) {
      await page.goto(href);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await settled();
      if (href === '/territorio') {
        await page.getByRole('button', { name: new RegExp(actorName) }).click();
        await expect(page.getByRole('link', { name: actorName, exact: true })).toBeVisible();
        await settled();
      }
      const small = await smallTargets(page);
      if (small.length > 0) found[href] = small;
      // The visible screen only: a full-page capture resizes the emulated phone and drops its
      // touch pointer, so the capture would show desktop control sizes.
      if (dir) {
        await page.screenshot({
          path: `${dir}/360-${name}-${colorScheme}.png`,
          animations: 'disabled',
        });
      }
    }
    expect(found).toEqual({});
  });
}
