import { analyzeAccessibility } from '../support/accessibility.ts';
import { DESTINATIONS, SCREENS, hubHref } from '../../web/src/app/navigation.ts';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';
import { watchNetwork } from '../support/network.ts';
import { headingSkips, smallTargets } from './target-size.ts';

/**
 * Pointer targets, heading order and axe on every screen at a phone, a laptop and a wide desktop
 * width (odd/archive/functional-10.md T7, F20–F21): each link and button outside a sentence is at
 * least 24×24 px (WCAG 2.2 SC 2.5.8, measured without the spacing exception), no heading skips a
 * level, the WCAG 2.2 AA rules of axe pass and the page never scrolls sideways (T11: the same walk
 * on WebKit and at 360 px). Runs after the CRUD specs, so lists hold records.
 */
const MIN = 24;
const WIDTHS = [360, 930, 1440] as const;
const PAGES = [
  ...SCREENS.map((screen) => ({ path: screen.path, title: screen.title as string })),
  ...DESTINATIONS.map((hub) => ({ path: hub.path, title: hub.label as string })),
];

for (const width of WIDTHS) {
  test(`every screen at ${width} px: 24 px targets, no skipped heading, WCAG 2.2 AA, no sideways scroll`, async ({
    page,
    admin,
  }) => {
    // 35 screens with axe on each; bounded so a hung screen fails instead of stalling the run.
    test.setTimeout(420_000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: 900 });
    const settled = watchNetwork(page);
    await signInToProject(page, admin, DEFAULT_SCOPE);
    const small: Record<string, string[]> = {};
    const skips: Record<string, string[]> = {};
    const violations: Record<string, string[]> = {};
    const wide: Record<string, { scroll: number; view: number }> = {};
    for (const { path, title } of PAGES) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeAttached();
      await settled();
      const targets = await smallTargets(page, MIN, { equivalentSvg: true });
      if (targets.length > 0) small[path] = targets;
      const widths = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        view: document.documentElement.clientWidth,
      }));
      if (widths.scroll > widths.view) wide[path] = widths;
      const skipped = await headingSkips(page);
      if (skipped.length > 0) skips[path] = skipped;
      const result = await analyzeAccessibility(page);
      if (result.violations.length > 0)
        violations[path] = result.violations.map(
          (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
        );
    }
    expect({ small, skips, violations, wide }).toEqual({
      small: {},
      skips: {},
      violations: {},
      wide: {},
    });
  });
}

/**
 * F22: an empty save of a new record reports its errors in the page, not in the browser's bubble:
 * the required field is marked invalid with its message, a summary leads the form, focus lands on
 * the field, and the form with its errors still passes axe and the 24 px check.
 */
test('an empty new record shows in-page errors and focuses the first invalid field', async ({
  page,
  admin,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/eventos');
  await page.getByRole('button', { name: 'Nuevo registro' }).click();
  const form = page.getByRole('form', { name: 'Nuevo registro' });
  await form.getByRole('button', { name: 'Guardar registro' }).click();
  const field = form.getByLabel('Descripción del hecho', { exact: true });
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(field).toHaveAccessibleDescription('Completa este campo.');
  await expect(field).toBeFocused();
  await expect(
    form.getByRole('group', { name: 'No se pudo guardar: revisa 1 campo.' }),
  ).toBeVisible();
  // The native constraint still holds: the browser reports the field as missing.
  expect(
    await field.evaluate((element: HTMLTextAreaElement) => element.validity.valueMissing),
  ).toBe(true);
  expect(await smallTargets(page, MIN, { equivalentSvg: true })).toEqual([]);
  const { violations } = await analyzeAccessibility(page);
  expect(violations.map((v) => v.id)).toEqual([]);
});

/**
 * F23: the hub section shown is announced. Each section is a toggle button in a group named
 * after the hub, and exactly the current one is `aria-pressed="true"`, from the real server.
 */
test('every hub section announces the current one with aria-pressed', async ({ page, admin }) => {
  test.setTimeout(180_000);
  const settled = watchNetwork(page);
  await signInToProject(page, admin, DEFAULT_SCOPE);
  for (const hub of DESTINATIONS.filter((item) => item.path !== '/registros')) {
    for (const tab of hub.tabs) {
      await page.goto(hubHref(hub, tab.value));
      const group = page.getByRole('group', { name: hub.label, exact: true });
      await expect(group.getByRole('button', { name: tab.label, exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(group.locator('[aria-pressed="true"]')).toHaveCount(1);
      await expect(group.locator('[aria-pressed="false"]')).toHaveCount(hub.tabs.length - 1);
      // The map tabs load chunks and workers; WebKit reports the ones the next navigation
      // aborts as console and page errors, so each tab settles before the next one opens.
      await settled();
    }
  }
  await page.goto('/registros?tipo=eventos');
  const types = page.getByRole('group', { name: 'Tipo de registro', exact: true });
  await expect(types.locator('[aria-pressed="true"]')).toHaveCount(1);
  await expect(types.locator('[aria-pressed="true"]')).toContainText('Eventos');
});
