import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/** Reads the scroll chrome of an element: what the browser draws while it scrolls. */
const chrome = (sel: string) => {
  const element = document.querySelector(sel);
  if (!element) throw new Error(`Missing ${sel}`);
  const style = getComputedStyle(element);
  return {
    width: style.scrollbarWidth,
    colour: style.scrollbarColor,
    overscroll: style.overscrollBehaviorY,
  };
};

test('scrollbars are thin and quiet, and the sidebar hides its bar until it is used', async ({
  page,
  admin,
}) => {
  await page.setViewportSize({ width: 1440, height: 600 });
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/eventos');
  const sidebar = page.locator('aside').first();
  await expect(sidebar).toBeVisible();
  const nav = sidebar.getByRole('navigation', { name: 'Secciones' });

  // The page scrollbar: thin, a token thumb on an invisible track.
  const root = await page.evaluate(chrome, 'html');
  expect(root.width).toBe('thin');
  expect(root.colour).toMatch(/^rgba?\(.+\) rgba\(0, 0, 0, 0\)$/);

  // Only the navigation scrolls: its bar is invisible at rest and never drags the page.
  await page.mouse.move(1000, 300);
  const rest = await page.evaluate(chrome, 'aside nav');
  expect(rest.width).toBe('thin');
  expect(rest.overscroll).toBe('contain');
  expect(rest.colour).toBe('rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)');

  await nav.hover();
  const used = await page.evaluate(chrome, 'aside nav');
  expect(used.colour).toBe(root.colour);

  // Open every section so the list outgrows a 600px screen, then scroll it to the end.
  for (const section of ['Monitoreo', 'Gestión y alertas', 'Análisis']) {
    const toggle = nav.getByRole('button', { name: new RegExp(`^${section}`) });
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  }
  const brand = sidebar.getByTitle('Sistema Inteligente de Predicción y GEStión Social');
  const account = sidebar.getByRole('button', { name: /^Cuenta de / });
  const brandBefore = await brand.boundingBox();
  await nav.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  expect(await nav.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  // The brand stays at the top and the account at the bottom while the navigation scrolls.
  const [brandAfter, sidebarBox] = [await brand.boundingBox(), await sidebar.boundingBox()];
  if (!brandBefore || !brandAfter || !sidebarBox) throw new Error('Missing sidebar or brand box');
  expect(brandAfter.y).toBe(brandBefore.y);
  expect(brandAfter.y - sidebarBox.y).toBeLessThanOrEqual(24);
  await expect(account).toBeInViewport();
  await expect(nav.getByRole('link', { name: 'Fuentes' })).toBeInViewport();
});
