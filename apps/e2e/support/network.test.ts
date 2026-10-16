import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { Frame, Page, Request } from '@playwright/test';
import { watchNetwork } from './network.ts';

const fixture = () => {
  const events = new EventEmitter();
  const mainFrame = {} as Frame;
  const childFrame = {} as Frame;
  const page = Object.assign(events, {
    mainFrame: () => mainFrame,
    waitForLoadState: async () => {},
    waitForTimeout: () => new Promise<void>((resolve) => setTimeout(resolve, 1)),
  }) as unknown as Page;
  const request = (path: string, navigation = false, frame = mainFrame) =>
    ({
      url: () => `http://localhost${path}`,
      isNavigationRequest: () => navigation,
      frame: () => frame,
    }) as Request;
  return { events, mainFrame, childFrame, request, settled: watchNetwork(page) };
};

test('a committed main document releases abandoned requests from the previous document', async () => {
  const f = fixture();
  f.events.emit('request', f.request('/assets/old-preload.js'));
  const document = f.request('/new', true);
  f.events.emit('request', document);
  f.events.emit('framenavigated', f.mainFrame);
  f.events.emit('requestfinished', document);
  await f.settled(0, 20);
});

test('navigation keeps its document and assets started before the commit under observation', async () => {
  const f = fixture();
  const document = f.request('/new', true);
  const asset = f.request('/assets/current.js');
  f.events.emit('request', document);
  f.events.emit('request', asset);
  f.events.emit('framenavigated', f.mainFrame);
  await assert.rejects(f.settled(0, 10), /Network still busy:.*\/new.*current.js/);
  f.events.emit('requestfinished', document);
  await assert.rejects(f.settled(0, 10), /current.js/);
  f.events.emit('requestfinished', asset);
  await f.settled(0, 20);
});

test('same-document URL changes retain active requests', async () => {
  const f = fixture();
  const asset = f.request('/api/actores');
  f.events.emit('request', asset);
  f.events.emit('framenavigated', f.mainFrame);
  await assert.rejects(f.settled(0, 10), /\/api\/actores/);
});

test('child-frame navigation never clears main document requests', async () => {
  const f = fixture();
  f.events.emit('request', f.request('/api/actores'));
  f.events.emit('request', f.request('/embedded', true, f.childFrame));
  f.events.emit('framenavigated', f.childFrame);
  await assert.rejects(f.settled(0, 10), /\/api\/actores/);
});

test('an uncommitted failed navigation keeps previous document activity', async () => {
  const f = fixture();
  f.events.emit('request', f.request('/api/actores'));
  const document = f.request('/failed', true);
  f.events.emit('request', document);
  f.events.emit('requestfailed', document);
  f.events.emit('framenavigated', f.mainFrame);
  await assert.rejects(f.settled(0, 10), /\/api\/actores/);
});

test('only the long-lived activity stream is excluded; failed finite requests settle', async () => {
  const f = fixture();
  f.events.emit('request', f.request('/system/events'));
  const finite = f.request('/api/eventos');
  f.events.emit('request', finite);
  await assert.rejects(f.settled(0, 10), /\/api\/eventos/);
  f.events.emit('requestfailed', finite);
  await f.settled(0, 20);
});
