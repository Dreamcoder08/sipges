import type { Page, Request } from '@playwright/test';

/** The live activity stream stays open by design (ADR 0014), so it never counts as busy. */
const LONG_LIVED = /\/system\/events$/;

/**
 * Replaces `waitForLoadState('networkidle')`, which never settles while the activity stream
 * is open: resolves once no other request has been in flight for `idleMs`.
 */
export const watchNetwork = (page: Page) => {
  const pending = new Map<Request, number>();
  let sequence = 0;
  // `responded` is the last request order seen when the navigation response arrived.
  let navigation: { request: Request; sequence: number; responded?: number } | null = null;
  const track = (request: Request) => {
    const order = ++sequence;
    if (request.isNavigationRequest() && request.frame() === page.mainFrame())
      navigation = { request, sequence: order };
    if (!LONG_LIVED.test(new URL(request.url()).pathname)) pending.set(request, order);
  };
  const done = (request: Request) => pending.delete(request);
  page.on('request', track);
  page.on('requestfinished', done);
  page.on('response', (response) => {
    if (navigation?.request === response.request()) navigation.responded = sequence;
  });
  page.on('requestfailed', (request) => {
    done(request);
    if (navigation?.request === request) navigation = null;
  });
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame() || !navigation) return;
    // Chromium can abandon preloads without a terminal request event on document teardown.
    // Only discard requests belonging to the old document after the new one commits: those
    // started before the navigation, and those it started while waiting for the navigation
    // response (idle-time preloads). The new document cannot request anything before that
    // response, so its navigation and assets stay, including those started before this event.
    const { sequence: started, responded = started } = navigation;
    for (const [request, order] of pending)
      if (order < started || (order > started && order <= responded)) pending.delete(request);
    navigation = null;
  });
  return async (idleMs = 500, timeoutMs = 30_000) => {
    await page.waitForLoadState('load');
    const deadline = Date.now() + timeoutMs;
    let quietSince = Date.now();
    while (Date.now() < deadline) {
      if (pending.size > 0) quietSince = Date.now();
      else if (Date.now() - quietSince >= idleMs) return;
      await page.waitForTimeout(50);
    }
    throw new Error(`Network still busy: ${[...pending.keys()].map((r) => r.url()).join(', ')}`);
  };
};
