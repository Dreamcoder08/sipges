import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/** Reads the scroll chrome of an element: what the browser draws while it scrolls. */
const chrome = (selector: string) => (sel: string) => {
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

  // The page scrollbar: thin, a token thumb on an invisible track.
  const root = await page.evaluate(chrome('html'), 'html');
  expect(root.width).toBe('thin');
  expect(root.colour).toMatch(/^rgba?\(.+\) rgba\(0, 0, 0, 0\)$/);

  // The sidebar scrolls on its own: its bar is invisible at rest and never drags the page.
  await page.mouse.move(1000, 300);
  const rest = await page.evaluate(chrome('aside'), 'aside');
  expect(rest.width).toBe('thin');
  expect(rest.overscroll).toBe('contain');
  expect(rest.colour).toBe('rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)');

  await sidebar.hover();
  const used = await page.evaluate(chrome('aside'), 'aside');
  expect(used.colour).toBe(root.colour);

  // The brand stays at the top while the navigation scrolls under it.
  await sidebar.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const brand = sidebar.getByTitle('Sistema Inteligente de Predicción y GEStión Social');
  const [brandBox, sidebarBox] = [await brand.boundingBox(), await sidebar.boundingBox()];
  if (!brandBox || !sidebarBox) throw new Error('Missing sidebar or brand box');
  expect(Math.abs(brandBox.y - sidebarBox.y)).toBeLessThanOrEqual(1);
  await expect(sidebar.getByRole('link', { name: 'Configuración' })).toBeInViewport();
});
