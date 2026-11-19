import type { Page } from '@playwright/test';

/**
 * WebKit's report of a load it gave up, for example «Fetch API cannot load
 * https://tile.openstreetmap.org/9/142/265.png due to access control checks.». WebKit logs it
 * as a JavaScript error, so Playwright delivers it as a page error, split at the first colon
 * with one more character dropped: name «Fetch API cannot load https», message
 * «/tile.openstreetmap.org/9/142/265.png due to access control checks.».
 */
const BLOCKED_LOAD_NAME = /^(?:Fetch API cannot load|Cannot load) https?$/;
const BLOCKED_LOAD_MESSAGE = /^\S+ due to access control checks\.$/;

export const isBlockedLoadReport = (error: Pick<Error, 'name' | 'message'>) =>
  BLOCKED_LOAD_NAME.test(error.name) && BLOCKED_LOAD_MESSAGE.test(error.message);

/**
 * WebKit also gives that report for every load the outgoing document still had pending when a
 * navigation replaces it: query fetches, the MapLibre worker script, tiles MapLibre had queued
 * (local-qa-findings T18; 9 of 20 WebKit runs of 37-console-per-screen under CPU load, none on
 * Chromium). Those loads are cancelled by the unload, not refused by the server or the CSP, and
 * no user ever sees the dying page's console.
 *
 * Returns a predicate that is true only for a blocked-load report received while the main frame
 * is between a navigation request and the commit of the new document. The same report while a
 * page is live (our own origin or any other) and every other page error still count.
 */
export const watchUnload = (page: Page) => {
  let unloading = false;
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) unloading = true;
  });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) unloading = false;
  });
  page.on('requestfailed', (request) => {
    // A navigation that never commits leaves the old document live again.
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) unloading = false;
  });
  return (error: Pick<Error, 'name' | 'message'>) => unloading && isBlockedLoadReport(error);
};
