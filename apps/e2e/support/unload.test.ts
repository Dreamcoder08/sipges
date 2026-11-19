import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { Frame, Page, Request } from '@playwright/test';
import { isBlockedLoadReport, watchUnload } from './unload.ts';

/** A page error as Playwright builds it from a WebKit console report (splitErrorMessage). */
const webkitReport = (text: string) => {
  const colon = text.indexOf(':');
  return { name: text.slice(0, colon), message: text.slice(colon + 2) };
};

const TILE = webkitReport(
  'Fetch API cannot load https://tile.openstreetmap.org/9/142/265.png due to access control checks.',
);
const OWN_API = webkitReport(
  'Fetch API cannot load http://localhost:45113/api/registros/summary?limit=500&offset=0 due to access control checks.',
);
const OWN_WORKER = webkitReport(
  'Cannot load http://localhost:45113/assets/maplibre-gl-worker-BslLc_p7.js due to access control checks.',
);

const fixture = () => {
  const events = new EventEmitter();
  const mainFrame = {} as Frame;
  const childFrame = {} as Frame;
  const page = Object.assign(events, { mainFrame: () => mainFrame }) as unknown as Page;
  const request = (navigation: boolean, frame = mainFrame) =>
    ({ isNavigationRequest: () => navigation, frame: () => frame }) as Request;
  return { events, mainFrame, childFrame, request, unloadReport: watchUnload(page) };
};

test('the WebKit report from PR #504 is recognised as Playwright delivers it', () => {
  assert.deepEqual(TILE, {
    name: 'Fetch API cannot load https',
    message: '/tile.openstreetmap.org/9/142/265.png due to access control checks.',
  });
  for (const report of [TILE, OWN_API, OWN_WORKER]) assert.equal(isBlockedLoadReport(report), true);
});

test('loads the outgoing document had pending are not failures of either screen', () => {
  const f = fixture();
  f.events.emit('request', f.request(true));
  for (const report of [TILE, OWN_API, OWN_WORKER]) assert.equal(f.unloadReport(report), true);
});

test('the same report while a page is live still fails, for our origin and any other', () => {
  const f = fixture();
  for (const report of [TILE, OWN_API, OWN_WORKER]) assert.equal(f.unloadReport(report), false);
  // After the new document commits, its own blocked loads count again.
  f.events.emit('request', f.request(true));
  f.events.emit('framenavigated', f.mainFrame);
  assert.equal(f.unloadReport(OWN_API), false);
});

test('a navigation that fails to commit leaves the old document live again', () => {
  const f = fixture();
  f.events.emit('request', f.request(true));
  f.events.emit('requestfailed', f.request(true));
  assert.equal(f.unloadReport(OWN_API), false);
});

test('fetches and iframe navigations do not open the window', () => {
  const f = fixture();
  f.events.emit('request', f.request(false));
  f.events.emit('request', f.request(true, f.childFrame));
  assert.equal(f.unloadReport(TILE), false);
});

test('other page errors fail even during an unload', () => {
  const f = fixture();
  f.events.emit('request', f.request(true));
  for (const error of [
    new TypeError('Load failed'),
    new Error('https://tile.openstreetmap.org/9/142/265.png due to access control checks.'),
    {
      name: 'Unhandled Promise Rejection',
      message: 'TypeError: Importing a module script failed.',
    },
    webkitReport(
      'Refused to load http://evil.example/x.js because it does not appear in the script-src directive of the Content Security Policy.',
    ),
  ])
    assert.equal(f.unloadReport(error), false, `${error.name}: ${error.message}`);
});
