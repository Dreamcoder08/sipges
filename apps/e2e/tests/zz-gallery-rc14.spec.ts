import type { Page } from '@playwright/test';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';
import { watchNetwork } from '../support/network.ts';

/**
 * The visit-rc14 gallery dudas at 1440 px (odd/tasks/functional-10.md T14). Runs last in the desktop
 * project, after the specs that seed the shared project.
 */
const atDesktop = async (page: Page, admin: { username: string; password: string }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const settled = watchNetwork(page);
  await signInToProject(page, admin, DEFAULT_SCOPE);
  return settled;
};

test('Auditoría at 1440 px has a visible title and names the project by its label', async ({
  page,
  admin,
}) => {
  await atDesktop(page, admin);
  await page.goto('/auditoria');
  const title = page
    .getByRole('main')
    .getByRole('heading', { level: 2, name: 'Auditoría', exact: true });
  await expect(title).toBeInViewport();
  // A real title, not the 1 px visually hidden h1 of the shell.
  expect((await title.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(20);
  const intro = page.getByText(/^Historial del proyecto/);
  await expect(intro).toBeVisible();
  await expect(intro).not.toContainText(DEFAULT_SCOPE);
  await expect(intro).not.toContainText('PRJ-');
});

test('Territorio at 1440 px draws every timeline dot whole inside its list', async ({
  page,
  admin,
  adminApi,
}) => {
  for (const place of ['Vice', 'Bernal'])
    expect(
      (
        await adminApi.post('/api/eventos', {
          headers: { 'X-SIPGES-Scope': DEFAULT_SCOPE },
          data: {
            payload: {
              Descripcion_Hecho: `Hecho sintético de la línea de tiempo en ${place}`,
              Fecha: '2026-10-12',
              Territorio: place,
            },
          },
        })
      ).status(),
    ).toBe(200);
  const settled = await atDesktop(page, admin);
  await page.goto('/territorio');
  const timeline = page.getByRole('list', { name: 'Registros del periodo' });
  await timeline.scrollIntoViewIfNeeded();
  await expect(timeline.getByRole('listitem').first()).toBeVisible();
  await settled();
  const cut = await timeline.evaluate((list) => {
    const left = list.getBoundingClientRect().left + list.clientLeft;
    return [...list.querySelectorAll('li > span[aria-hidden="true"]')]
      .slice(0, 5)
      .map((dot) => dot.getBoundingClientRect())
      .filter((dot) => dot.left < left - 0.5)
      .map((dot) => Math.round(left - dot.left));
  });
  expect(cut, 'pixels of each dot clipped by the list edge').toEqual([]);
});

/**
 * WCAG 1.4.11: what marks the chosen theme (its fill or its outline) must reach 3:1 against the
 * segments beside it. Solid colours, so the ratio comes from the computed styles
 * (verify-real-contrast: «Solid color: read computed styles, compute ratio analytically»).
 */
for (const colorScheme of ['dark', 'light'] as const) {
  test(`the chosen theme in Configuración stands out 3:1 from its neighbours (${colorScheme})`, async ({
    page,
    admin,
  }) => {
    await page.emulateMedia({ colorScheme });
    await atDesktop(page, admin);
    await page.goto('/configuracion?seccion=apariencia');
    const group = page.getByRole('group', { name: 'Tema' });
    await expect(group.getByRole('radio', { name: 'Sistema' })).toBeChecked();
    const ratios = await group.evaluate((fieldset) => {
      const rgba = (value: string) => {
        const [r = 0, g = 0, b = 0, a = 1] = (value.match(/[\d.]+/g) ?? []).map(Number);
        return { r, g, b, a: value.startsWith('rgba') ? a : 1 };
      };
      const over = (top: ReturnType<typeof rgba>, under: ReturnType<typeof rgba>) => ({
        r: top.a * top.r + (1 - top.a) * under.r,
        g: top.a * top.g + (1 - top.a) * under.g,
        b: top.a * top.b + (1 - top.a) * under.b,
        a: 1,
      });
      const luminance = ({ r, g, b }: ReturnType<typeof rgba>) => {
        const lin = (c: number) =>
          c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4;
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      };
      const ratio = (a: ReturnType<typeof rgba>, b: ReturnType<typeof rgba>) => {
        const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
        return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
      };
      // The opaque colour under the track: the first ancestor with a solid background.
      let node: Element | null = fieldset;
      let page = rgba('rgb(255, 255, 255)');
      while (node) {
        const bg = rgba(getComputedStyle(node).backgroundColor);
        if (bg.a >= 0.99) {
          page = bg;
          break;
        }
        node = node.parentElement;
      }
      const options = [...fieldset.querySelectorAll('label')];
      const chosen = options.find((label) => label.querySelector('input:checked'));
      const neighbour = options.find((label) => label !== chosen);
      if (!chosen || !neighbour || !chosen.parentElement) throw new Error('segments expected');
      const track = over(rgba(getComputedStyle(chosen.parentElement).backgroundColor), page);
      const beside = over(rgba(getComputedStyle(neighbour).backgroundColor), track);
      const style = getComputedStyle(chosen);
      const fill = over(rgba(style.backgroundColor), track);
      // An inset outline drawn with box-shadow, if any: its colour is the first one listed.
      const ring = style.boxShadow.includes('inset')
        ? over(rgba(style.boxShadow.match(/rgba?\([^)]*\)/)?.[0] ?? 'rgba(0,0,0,0)'), fill)
        : fill;
      // WCAG 1.4.3: the chosen segment's own label against its fill.
      const text = ratio(over(rgba(style.color), fill), fill);
      return { fill: ratio(fill, beside), ring: ratio(ring, beside), text };
    });
    // The measured ratios are part of the evidence the task asks for.
    test.info().annotations.push({ type: 'contrast', description: JSON.stringify(ratios) });
    console.log(`segment contrast (${colorScheme}): ${JSON.stringify(ratios)}`);
    expect(Math.max(ratios.fill, ratios.ring), JSON.stringify(ratios)).toBeGreaterThanOrEqual(3);
    expect(ratios.text, JSON.stringify(ratios)).toBeGreaterThanOrEqual(4.5);
  });
}
