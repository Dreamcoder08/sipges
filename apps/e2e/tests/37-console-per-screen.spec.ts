import type { ConsoleMessage, Page, Response } from '@playwright/test';
import { DESTINATIONS, SCREENS, hubHref } from '../../web/src/app/navigation.ts';
import {
  SETTINGS_PATH,
  SettingsSection,
  settingsHref,
} from '../../web/src/features/situations/sections.ts';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';
import { watchNetwork } from '../support/network.ts';

/**
 * Console errors per screen (functional-10 T10, F27). Every route of the menu (navigation.ts),
 * every hub tab and every section of Configuración is opened as an administrator, and any page
 * error, console error or same-origin HTTP error is reported against the screen that caused it.
 *
 * The suite-wide browserHygiene fixture keeps the CSP checks; it lets every «Failed to load
 * resource» through, which would also hide a screen whose API call answers 500. Here such a
 * message passes only when it is an external service the suite keeps offline.
 */

/**
 * Hosts playwright.config.ts resolves to nothing (public map tiles, elevation tiles, the
 * GEOCATMIN cadastre). They are offline by design in tests, so a screen that asks for them
 * gets net::ERR_NAME_NOT_RESOLVED and Chromium logs «Failed to load resource» for it. Keep in
 * step with --host-resolver-rules there.
 */
const OFFLINE_HOSTS = new Set([
  'tile.openstreetmap.org',
  'tiles.maps.eox.at',
  'geocatmin.ingemmet.gob.pe',
  's3.amazonaws.com',
]);

type Route = { readonly href: string; readonly heading: string };

const settingsTitle = SCREENS.find((screen) => screen.path === SETTINGS_PATH)?.title ?? '';

const ROUTES: readonly Route[] = [
  ...SCREENS.map((screen) => ({ href: screen.path, heading: screen.title })),
  ...DESTINATIONS.flatMap((hub) => [
    { href: hub.path, heading: hub.label },
    ...hub.tabs.map((tab) => ({ href: hubHref(hub, tab.value), heading: hub.label })),
  ]),
  ...SettingsSection.options.map((section) => ({
    href: settingsHref(section),
    heading: settingsTitle,
  })),
].filter((route, index, all) => all.findIndex((other) => other.href === route.href) === index);

const offline = (url: string) => {
  try {
    return OFFLINE_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
};

/** Collects what goes wrong on the page; `take` returns it and starts the next screen clean. */
const watchProblems = (page: Page, origin: string) => {
  let problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    const source = message.location().url;
    if (text.startsWith('Failed to load resource') && offline(source)) return;
    problems.push(`console: ${text}${source ? ` (${source})` : ''}`);
  });
  page.on('response', (response: Response) => {
    const url = new URL(response.url());
    if (url.origin === origin && response.status() >= 400)
      problems.push(`http ${response.status()}: ${response.request().method()} ${url.pathname}`);
  });
  return () => {
    const taken = problems;
    problems = [];
    return taken;
  };
};

const attachFindings = async (found: Record<string, string[]>) =>
  test.info().attach('console-per-screen', {
    body: JSON.stringify({ routes: ROUTES.map((route) => route.href), found }, null, 2),
    contentType: 'application/json',
  });

test('no screen logs a console error, a page error or a failed API call', async ({
  page,
  admin,
  baseURL,
}) => {
  // About 65 routes, each settled before the next: 46 s on a local run, above the 60 s default
  // once a CI runner is slower.
  test.setTimeout(240_000);
  const settled = watchNetwork(page);
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await settled();
  const take = watchProblems(page, new URL(baseURL ?? '').origin);

  const found: Record<string, string[]> = {};
  for (const route of ROUTES) {
    await page.goto(route.href);
    await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeVisible();
    // Lazy chunks and their queries finish before the next screen, so nothing is misattributed.
    await settled();
    const problems = take();
    if (problems.length) found[route.href] = problems;
  }
  await attachFindings(found);
  expect(found, `${ROUTES.length} routes`).toEqual({});
});
