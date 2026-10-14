import type { Page, Request } from '@playwright/test';

/** The live activity stream stays open by design (ADR 0014), so it never counts as busy. */
const LONG_LIVED = /\/system\/events$/;

/**
 * Replaces `waitForLoadState('networkidle')`, which never settles while the activity stream
 * is open: resolves once no other request has been in flight for `idleMs`.
 */
export const watchNetwork = (page: Page) => {
  const pending = new Set<Request>();
  const track = (request: Request) => {
    if (!LONG_LIVED.test(new URL(request.url()).pathname)) pending.add(request);
  };
  const done = (request: Request) => pending.delete(request);
  page.on('request', track);
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  return async (idleMs = 500, timeoutMs = 30_000) => {
    await page.waitForLoadState('load');
    const deadline = Date.now() + timeoutMs;
    let quietSince = Date.now();
    while (Date.now() < deadline) {
      if (pending.size > 0) quietSince = Date.now();
      else if (Date.now() - quietSince >= idleMs) return;
      await page.waitForTimeout(50);
    }
    throw new Error(`Network still busy: ${[...pending].map((r) => r.url()).join(', ')}`);
  };
};
