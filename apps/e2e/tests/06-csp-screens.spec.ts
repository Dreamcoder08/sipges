import { SCREENS, VERSION4_PATHS } from '../../web/src/app/navigation.ts';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';
import { watchNetwork } from '../support/network.ts';

/** Directives that would weaken the SPA policy (docs/migration/web.md, ADR 0006). */
const UNSAFE = /'unsafe-(inline|eval|hashes)'|'wasm-unsafe-eval'|\*|data:\s*;?\s*script/;

test('the SPA shell and its assets are served with a strict CSP', async ({ page }) => {
  const response = await page.goto('/login');
  const csp = (await response?.headerValue('content-security-policy')) ?? '';
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("style-src 'self'");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toMatch(UNSAFE);

  const html = (await response?.text()) ?? '';
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
  expect(html).not.toMatch(/\son[a-z]+=/i);
  expect(html).not.toMatch(/<style/i);
});

test('the policy is enforced: injected inline scripts and handlers are blocked', async ({
  browser,
  baseURL,
}) => {
  // Separate context: these violations are provoked on purpose and asserted here.
  const context = await browser.newContext({ baseURL: baseURL ?? '' });
  const page = await context.newPage();
  const violations: string[] = [];
  await page.exposeFunction('reportViolation', (directive: string) => violations.push(directive));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      (window as unknown as { reportViolation(d: string): void }).reportViolation(
        event.effectiveDirective,
      );
    });
  });
  await page.goto('/login');
  const result = await page.evaluate(async () => {
    const marker = window as unknown as { injected?: boolean };
    const script = document.createElement('script');
    script.textContent = 'window.injected = true';
    document.head.append(script);
    // Inline event handler attribute (script-src-attr). Code evaluated through the DevTools
    // protocol bypasses CSP, so eval cannot be probed from here; the zod/no-eval check is the
    // hygiene fixture on every screen.
    const button = document.createElement('button');
    button.setAttribute('onclick', 'window.handled = true');
    document.body.append(button);
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const handled = (window as unknown as { handled?: boolean }).handled === true;
    return { injected: marker.injected === true, handled };
  });
  expect(result).toEqual({ injected: false, handled: false });
  await expect.poll(() => violations.sort()).toEqual(['script-src-attr', 'script-src-elem']);
  await context.close();
});

test('every screen renders without CSP violations or script errors', async ({ page, admin }) => {
  // browserHygiene (auto fixture) fails the test on any CSP report, page error or console error.
  const settled = watchNetwork(page);
  await signInToProject(page, admin, DEFAULT_SCOPE);
  for (const screen of SCREENS) {
    await page.goto(screen.path);
    await expect(page.getByRole('heading', { level: 1, name: screen.title })).toBeVisible();
    await expect(page).toHaveTitle(new RegExp(screen.title));
    const link = page
      .getByRole('navigation', { name: 'Secciones' })
      .getByRole('link', { name: screen.label, exact: true });
    // MASCLI 4.0 screens stay out of the menu while the project keeps 3.0 (docs/adr/0020).
    if (VERSION4_PATHS.has(screen.path)) await expect(link).toHaveCount(0);
    else await expect(link).toHaveAttribute('aria-current', 'page');
    // Let lazy chunks and their queries settle before moving on.
    await settled();
  }
});
