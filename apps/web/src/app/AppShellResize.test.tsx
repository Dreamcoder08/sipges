import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { resetApi } from '../test/server.ts';
import { App } from './App.tsx';

afterEach(() => vi.unstubAllGlobals());

it('defers top-bar layout writes until the observer batch ends and removes them on unmount', async () => {
  const observers: { target?: Element; callback: ResizeObserverCallback }[] = [];
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  class Observer {
    item: { target?: Element; callback: ResizeObserverCallback };
    constructor(callback: ResizeObserverCallback) {
      this.item = { callback };
      observers.push(this.item);
    }
    observe(target: Element) {
      this.item.target = target;
    }
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', Observer);
  // Only the compact layout has a sticky top bar.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(max-width: 60rem)',
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  resetApi({ me: { username: 'demo', full_name: 'Persona de prueba', role: 'admin' } });
  const { unmount } = render(<App />);
  await screen.findByRole('heading', { level: 1, name: 'Dashboard ejecutivo' });
  const bar = screen.getByRole('button', { name: /Cambiar de proyecto/ }).closest('header');
  if (!bar) throw new Error('Top bar missing');
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (frame: number) => frames.delete(frame));
  Object.defineProperty(bar, 'offsetHeight', { value: 80 });
  const observer = observers.find((item) => item.target === bar);
  expect(observer).toBeDefined();
  act(() => observer?.callback([], {} as ResizeObserver));
  expect(document.documentElement.style.getPropertyValue('--topbar-height')).toBe('');
  act(() => {
    for (const [frame, callback] of frames) {
      frames.delete(frame);
      callback(0);
    }
  });
  expect(document.documentElement.style.getPropertyValue('--topbar-height')).toBe('80px');
  unmount();
  expect(document.documentElement.style.getPropertyValue('--topbar-height')).toBe('');
});
