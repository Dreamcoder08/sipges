import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/**
 * WCAG 2.2 SC 2.4.11 Focus Not Obscured (Minimum) on the desktop lists with a sticky header:
 * Registros › Todos (table, ≥ 1024 px) and Bandeja › Pendientes. Axe cannot check it, so the keys
 * walk down far enough to scroll the list and back up, and at every stop the item that has the
 * keyboard focus must not be entirely covered by a sticky bar, and the point at its centre must
 * hit it (or a descendant). In a listbox with `aria-activedescendant` that item is the active
 * option, which is where the focus ring is drawn.
 */
const ROWS = 40;
const STEPS = 30;

const seed = async (adminApi: APIRequestContext, stamp: number) => {
  for (let n = 1; n <= ROWS; n += 1) {
    // No source: each one is also a «Calidad de datos» pending item in Bandeja.
    const payload = {
      ID_Evento: `EV-F${n}-${stamp}`,
      Fecha: '2026-10-12',
      Territorio: 'Vice, Sechura',
      Descripcion_Hecho: `Hecho sintético ${String(n).padStart(2, '0')} para el foco ${stamp}`,
    };
    const created = await adminApi.post('/api/eventos', {
      headers: { 'X-SIPGES-Scope': DEFAULT_SCOPE },
      data: { payload },
    });
    expect(created.status(), await created.text()).toBe(200);
  }
};

/** Why the focused item is obscured, or '' when a person can see it. */
const obscured = (scroller: Locator) =>
  scroller.evaluate((container) => {
    const active = document.activeElement;
    const descendant = active?.getAttribute('aria-activedescendant');
    const target = descendant ? document.getElementById(descendant) : active;
    if (!(target instanceof HTMLElement) || !container.contains(target))
      return 'focus left the list';
    const box = target.getBoundingClientRect();
    const name = (target.textContent ?? '').trim().slice(0, 48);
    const covering = [...container.querySelectorAll<HTMLElement>('*')].find((node) => {
      if (getComputedStyle(node).position !== 'sticky' || node.contains(target)) return false;
      const bar = node.getBoundingClientRect();
      return (
        bar.top <= box.top &&
        bar.bottom >= box.bottom &&
        bar.left <= box.left &&
        bar.right >= box.right
      );
    });
    if (covering)
      return `«${name}» is entirely under the sticky ${covering.tagName.toLowerCase()} «${(covering.textContent ?? '').trim().slice(0, 24)}»`;
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (hit && (hit === target || target.contains(hit))) return '';
    const what = hit
      ? `${hit.tagName.toLowerCase()} «${(hit.textContent ?? '').trim().slice(0, 24)}»`
      : 'nothing';
    return `«${name}»: its centre (${Math.round(x)}, ${Math.round(y)}) hits ${what}`;
  });

/** Presses `key` `times` times, recording every stop where the focused item is obscured. */
const walk = async (page: Page, scroller: Locator, key: string, times: number) => {
  const problems: string[] = [];
  for (let step = 1; step <= times; step += 1) {
    await page.keyboard.press(key);
    const problem = await obscured(scroller);
    if (problem) problems.push(`${key} #${step}: ${problem}`);
  }
  return problems;
};

test('Registros › Todos at 1440 px keeps the focused row clear of its sticky header', async ({
  page,
  admin,
  adminApi,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  const stamp = Date.now();
  await seed(adminApi, stamp);
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/registros?tipo=todos');
  const scroller = page.getByRole('region', { name: 'Tabla de registros' });
  const grid = scroller.getByRole('grid');
  await expect(
    grid.getByRole('row').filter({ hasText: `Hecho sintético ${ROWS} para el foco ${stamp}` }),
  ).toHaveCount(1);
  const first = grid.getByRole('row').nth(1).getByRole('button');
  await first.focus();
  await expect(first).toBeFocused();

  const down = await walk(page, scroller, 'ArrowDown', STEPS);
  // The walk must actually scroll the table, or it proves nothing.
  expect(await scroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  const up = await walk(page, scroller, 'ArrowUp', STEPS);
  expect([...down, ...up], 'SC 2.4.11 on Registros › Todos').toEqual([]);
});

test('Bandeja › Pendientes at 1440 px keeps the active row clear of its sticky bars', async ({
  page,
  admin,
  adminApi,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  const stamp = Date.now();
  await seed(adminApi, stamp);
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/bandeja?clase=calidad');
  const scroller = page.getByRole('region', { name: 'Pendientes', exact: true });
  const box = page.getByRole('listbox', { name: 'Pendientes de decisión' });
  await expect(
    box.getByRole('option', { name: new RegExp(`Hecho sintético ${ROWS} para el foco ${stamp}`) }),
  ).toHaveCount(1);
  await box.focus();
  await expect(box).toBeFocused();

  const down = await walk(page, scroller, 'ArrowDown', STEPS);
  expect(await scroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  const up = await walk(page, scroller, 'ArrowUp', STEPS);
  expect([...down, ...up], 'SC 2.4.11 on Bandeja › Pendientes').toEqual([]);
});
