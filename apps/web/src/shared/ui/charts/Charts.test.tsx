import { act, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ColumnChart } from './Charts.tsx';

afterEach(() => vi.unstubAllGlobals());

it('updates chart geometry after the observer delivery and cancels a pending frame on unmount', () => {
  let notify: ResizeObserverCallback | undefined;
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  class Observer {
    constructor(callback: ResizeObserverCallback) {
      notify = callback;
    }
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', Observer);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (frame: number) => frames.delete(frame));
  const { container, unmount } = render(
    <ColumnChart
      data={[{ key: 'a', label: 'Prueba', value: 1 }]}
      caption="Eventos de prueba"
      empty="Sin eventos"
    />,
  );
  const svg = container.querySelector('svg');
  const deliver = (width: number) =>
    act(() => notify?.([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver));
  deliver(500);
  // Updating the observed SVG inside delivery changes its auto height and loops in WebKit.
  expect(svg).toHaveAttribute('viewBox', '0 0 320 180');
  act(() => {
    for (const [frame, callback] of frames) {
      frames.delete(frame);
      callback(0);
    }
  });
  expect(svg).toHaveAttribute('viewBox', '0 0 500 180');
  deliver(450);
  unmount();
  expect(frames.size).toBe(0);
});
