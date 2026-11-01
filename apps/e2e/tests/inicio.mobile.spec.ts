import AxeBuilder from '@axe-core/playwright';
import type { Locator } from '@playwright/test';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

const box = async (locator: Locator) => {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error('element has no box');
  return rect;
};

/**
 * Inicio on a phone reads like a chat app (ChatGPT, Claude): the greeting centred in the free
 * space, the briefing as one-line rows, the suggestions in one swipeable strip and the composer
 * resting just above the bottom bar.
 */
for (const colorScheme of ['light', 'dark'] as const) {
  test(`Inicio on a phone is a chat-style home (${colorScheme})`, async ({ page, admin }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await signInToProject(page, admin, DEFAULT_SCOPE);
    await page.goto('/inicio');

    const composer = page.locator('form').filter({ has: page.getByLabel('Pregunta a SIPGES') });
    const bar = page.getByRole('navigation', { name: 'Navegación principal' });
    await expect(composer).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Hola/ })).toBeVisible();

    // The date line is desktop chrome; the header already names the project.
    await expect(page.getByText(/de \d{4}/)).toBeHidden();

    // The composer sits right above the bottom bar without scrolling.
    const composerBox = await box(composer);
    const barBox = await box(bar);
    expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(barBox.y);
    expect(barBox.y - (composerBox.y + composerBox.height)).toBeLessThanOrEqual(24);

    // Briefing cards collapse to one tappable row each.
    const cards = page.getByRole('region', { name: /Alertas activas|Registros nuevos|Riesgo/ });
    await expect(cards.first()).toBeVisible();
    for (const card of await cards.all()) {
      expect((await box(card)).height).toBeLessThanOrEqual(64);
    }

    // Suggestions share one line and never widen the page.
    const chips = page.getByRole('list', { name: 'Prueba con' }).getByRole('button');
    const tops = new Set<number>();
    for (const chip of await chips.all()) tops.add(Math.round((await box(chip)).y));
    expect(tops.size).toBe(1);
    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      view: document.documentElement.clientWidth,
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.view);

    // A suggestion still fills the composer.
    await chips.first().tap();
    await expect(page.getByLabel('Pregunta a SIPGES')).toHaveValue(/\S/);

    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });
}
