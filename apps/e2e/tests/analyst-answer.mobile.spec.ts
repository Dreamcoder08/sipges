import { analyzeAccessibility } from '../support/accessibility.ts';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';
import { fakeAnalyst } from '../support/analyst-thread.ts';

/*
 * The Inicio analyst's answer on a phone (odd/archive/agentic-analyst.md T1d, T2): text, sources and
 * the four block kinds, with long titles, at 360 and 412 px in light and dark. This e2e API has no
 * analyst (only the Go API does), so the browser answers the question with a synthetic reply, and
 * the project settings say external AI is on.
 */
const long =
  'Comunidad campesina sintética de la parte alta del valle con un nombre muy largo para la prueba';

const reply = {
  answer:
    'La comunidad mantiene la mesa de diálogo abierta [1] y la alerta por el bloqueo de la vía sigue activa [2]; ' +
    'la última asamblea pidió una nueva reunión con la empresa [3].',
  sources: [
    { n: 1, module: 'actores', id: 'A-SINTETICO-0001', title: long },
    { n: 2, module: 'alertas', id: 'AL-SINTETICO-0002', title: `Bloqueo de vía · ${long}` },
    { n: 3, module: 'eventos', id: 'EV-SINTETICO-0003', title: `Asamblea · ${long}` },
  ],
  blocks: [
    { type: 'record', n: 1, module: 'actores', id: 'A-SINTETICO-0001', title: long },
    {
      type: 'alert',
      n: 2,
      module: 'alertas',
      id: 'AL-SINTETICO-0002',
      title: `Bloqueo de vía · ${long}`,
      text: 'El bloqueo continúa y la comunidad pide la presencia de la autoridad regional para dialogar.',
    },
    { type: 'map', n: 3, module: 'eventos', id: 'EV-SINTETICO-0003', title: `Asamblea · ${long}` },
    {
      type: 'timeline',
      n: 3,
      module: 'eventos',
      id: 'EV-SINTETICO-0003',
      title: `Asamblea · ${long}`,
      entries: [
        {
          date: '2026-10-01',
          text: 'Primera asamblea con la empresa y la comunidad del valle alto.',
        },
        {
          date: '2026-10-15',
          text: 'Se acuerda una mesa técnica sobre el agua y el canal de riego.',
        },
      ],
    },
  ],
};

for (const width of [360, 412]) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`the analyst answer fits a ${width} px phone without sideways scroll (${colorScheme})`, async ({
      page,
      admin,
    }) => {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await page.setViewportSize({ width, height: 800 });
      await fakeAnalyst(page, { externalAi: true });
      await page.route('**/system/analyst/ask', (route) => route.fulfill({ json: reply }));
      await signInToProject(page, admin, DEFAULT_SCOPE);
      await page.goto('/inicio');

      const composer = page.getByRole('textbox', { name: 'Preguntar, con citas' });
      await composer.fill('¿Qué pasa con la comunidad del valle alto?');
      await composer.press('Enter');
      const answer = page.getByRole('region', { name: 'Respuesta del analista' });
      await expect(answer.getByRole('link', { name: /^Fuente 1:/ })).toBeVisible();

      const overflow = await page.evaluate(() => {
        const root = document.scrollingElement ?? document.documentElement;
        return root.scrollWidth - root.clientWidth;
      });
      expect(overflow, 'no sideways scroll').toBeLessThanOrEqual(0);

      // Every part of the answer stays inside the screen, and each one can be scrolled clear of
      // the composer docked at the bottom.
      const parts = answer.locator('p, li, article, [role="alert"]');
      const dock = await page.locator('form[data-ai]').boundingBox();
      for (const part of await parts.all()) {
        await part.scrollIntoViewIfNeeded();
        const box = await part.boundingBox();
        if (!box) continue;
        expect(box.x, 'left edge on screen').toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, 'right edge on screen').toBeLessThanOrEqual(width + 0.5);
      }
      const last = parts.last();
      await last.evaluate((el) => el.scrollIntoView({ block: 'end' }));
      const lastBox = await last.boundingBox();
      const dockNow = await page.locator('form[data-ai]').boundingBox();
      if (lastBox && dockNow && dock && dockNow.y > 400) {
        expect(lastBox.y, 'the last block starts above the docked composer').toBeLessThan(
          dockNow.y,
        );
      }

      const audit = await analyzeAccessibility(page);
      expect(audit.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    });
  }
}
