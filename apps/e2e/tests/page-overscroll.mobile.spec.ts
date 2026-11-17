import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/* On a touch phone the browser keeps its own edge gestures, such as pull to refresh. */
test('the page keeps the browser edge gestures on a phone', async ({ page, admin }) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/inicio');
  const behaviour = await page.evaluate(
    () => getComputedStyle(document.documentElement).overscrollBehaviorY,
  );
  expect(behaviour).toBe('auto');
});
