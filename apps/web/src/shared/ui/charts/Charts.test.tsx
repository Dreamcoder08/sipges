import { act, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ColumnChart, LineChart, RadarChart } from './Charts.tsx';

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

// functional-10 T2 (F4): chart values follow the app's number rule, decimal comma and one decimal.
it('writes chart values with a decimal comma and one decimal, counts without decimals', () => {
  const radar = render(
    <RadarChart
      caption="Puntaje por dimensión"
      data={[
        { key: 'G', label: 'G', value: 7.2 },
        { key: 'I', label: 'I', value: 33.333333 },
        { key: 'A', label: 'A', value: 0 },
      ]}
    />,
  );
  const cells = [...radar.container.querySelectorAll('td')].map((td) => td.textContent);
  expect(cells).toEqual(['7,2', '33,3', '0']);
  radar.unmount();
  const line = render(
    <LineChart
      caption="Cortes"
      empty="Sin cortes"
      data={[
        { key: 'a', label: '13 nov.', value: 1 },
        { key: 'b', label: '14 nov.', value: 2.78 },
      ]}
    />,
  );
  expect([...line.container.querySelectorAll('td')].map((td) => td.textContent)).toEqual([
    '1',
    '2,8',
  ]);
});
