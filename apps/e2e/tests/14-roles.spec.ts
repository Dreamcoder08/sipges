import { SCREENS } from '../../web/src/app/navigation.ts';
import {
  DEFAULT_SCOPE,
  createAccount,
  expect,
  signInToProject,
  test,
} from '../support/fixtures.ts';
import { watchNetwork } from '../support/network.ts';

/**
 * Non-admin roles see every screen without error banners: a screen either works for the role
 * or says plainly what the role cannot do (odd/tasks/full-functionality.md S1).
 */
for (const role of ['analista', 'coordinador', 'consulta'] as const) {
  test(`${role}: every screen opens without errors`, async ({ page, adminApi }) => {
    const credentials = await createAccount(
      adminApi,
      { username: `rol-${role}-${Date.now()}`, role },
      [DEFAULT_SCOPE],
    );
    const settled = watchNetwork(page);
    const refused: string[] = [];
    page.on('response', (response) => {
      const { pathname } = new URL(response.url());
      if (response.status() >= 400 && /^\/(api|system)\//.test(pathname))
        refused.push(`${response.status()} ${response.request().method()} ${pathname}`);
    });
    await signInToProject(page, credentials, DEFAULT_SCOPE);
    for (const screen of SCREENS) {
      await page.goto(screen.path);
      await expect(page.getByRole('heading', { level: 1, name: screen.title })).toBeVisible();
      await settled();
      await expect(page.getByRole('alert'), `${role} on ${screen.path}`).toHaveCount(0);
    }
    // A screen must not ask the server for what the role cannot have.
    expect(refused, `${role}: refused requests`).toEqual([]);
  });
}
