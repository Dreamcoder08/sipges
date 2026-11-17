import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/*
 * With a touchpad or a mouse the page does not bounce past its top or bottom: Firefox-based
 * browsers (Zen) on a laptop stretched and snapped the whole screen back at each edge.
 */
test('the page does not bounce at its edges on a laptop', async ({ page, admin }) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/inicio');
  const behaviour = await page.evaluate(
    () => getComputedStyle(document.documentElement).overscrollBehaviorY,
  );
  expect(behaviour).toBe('none');
});
