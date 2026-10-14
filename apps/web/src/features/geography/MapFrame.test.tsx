import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { BaseMap, UNITS_PER_DEGREE } from './BaseMap.tsx';
import { MapFrame } from './MapFrame.tsx';
import { useMapView } from './useMapView.ts';

const Harness = () => {
  const map = useMapView({ home: [-80.8, -5.6], homeSpan: 1, maxZoom: 8 });
  return (
    <MapFrame map={map} homeLabel="Ver todo">
      {(hint) => <BaseMap view={map.view} label="Mapa" title="Mapa" describedBy={hint} />}
    </MapFrame>
  );
};
/** [minLon, maxLat, width, height] in degrees, from the SVG viewBox. */
const box = () =>
  (screen.getByRole('group', { name: 'Mapa' }).getAttribute('viewBox') ?? '')
    .split(' ')
    .map((v) => Number(v) / UNITS_PER_DEGREE);

it('zooms with the buttons and keys, pans with the arrows and returns home', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const map = screen.getByRole('group', { name: 'Mapa' });
  expect(map).toHaveAttribute('tabindex', '0');
  expect(map).toHaveAccessibleDescription(/Arrastre/);
  const home = box();
  expect(home[2]).toBeCloseTo(1);
  expect(screen.getByRole('button', { name: 'Alejar' })).toBeDisabled();

  await user.click(screen.getByRole('button', { name: 'Acercar' }));
  expect(box()[2]).toBeCloseTo(0.5);
  map.focus();
  await user.keyboard('{ArrowRight}');
  expect(box()[0]).toBeGreaterThan(home[0] ?? 0);
  await user.keyboard('+');
  expect(box()[2]).toBeCloseTo(0.25);
  await user.keyboard('0');
  expect(box()).toEqual(home);

  for (let i = 0; i < 5; i += 1) await user.click(screen.getByRole('button', { name: 'Acercar' }));
  expect(box()[2]).toBeCloseTo(1 / 8);
  expect(screen.getByRole('button', { name: 'Acercar' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Ver todo' }));
  expect(box()).toEqual(home);
});

it('zooms with Ctrl + wheel and leaves a plain wheel to the page', async () => {
  render(<Harness />);
  const map = screen.getByRole('group', { name: 'Mapa' });
  fireEvent.wheel(map, { deltaY: -200 });
  expect(box()[2]).toBeCloseTo(1);
  fireEvent.wheel(map, { deltaY: -200, ctrlKey: true });
  // One render once the gesture settles, not one per wheel event.
  expect(box()[2]).toBeCloseTo(1);
  await waitFor(() => expect(box()[2]).toBeLessThan(1));
});

it('moves the drawn map with a transform during a drag and renders once at the end', async () => {
  // jsdom has no PointerEvent: a mouse event that carries a pointer id stands in for it.
  class TestPointerEvent extends MouseEvent {
    pointerId: number;
    pointerType = 'mouse';
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  render(<Harness />);
  const map = screen.getByRole('group', { name: 'Mapa' });
  const content = map.querySelector('[data-map-content]');
  const home = box();
  fireEvent.pointerDown(map, { pointerId: 1, clientX: 100, clientY: 100, button: 0 });
  for (let x = 98; x >= 80; x -= 2)
    fireEvent.pointerMove(map, { pointerId: 1, clientX: x, clientY: 100 });
  await waitFor(() => expect(content).toHaveAttribute('transform'));
  expect(box()).toEqual(home);
  fireEvent.pointerUp(map, { pointerId: 1, clientX: 80, clientY: 100 });
  expect(box()[0]).toBeGreaterThan(home[0] ?? 0);
  expect(content).not.toHaveAttribute('transform');
  vi.unstubAllGlobals();
});

it('sizes district dashes to the view, not to a fixed map unit', () => {
  render(
    <BaseMap view={[-81.2, -6.2, -80.2, -5.2]} label="Mapa" title="Mapa" background={<g />} />,
  );
  const width = 1 * UNITS_PER_DEGREE;
  const outlines = screen
    .getByRole('group', { name: 'Mapa' })
    .querySelectorAll('path[stroke-dasharray]');
  expect(outlines.length).toBeGreaterThan(0);
  for (const path of outlines) {
    const [dash] = (path.getAttribute('stroke-dasharray') ?? '').split(' ').map(Number);
    // A dash under 1/500 of the view is invisible and made each frame raster millions of them.
    expect(dash).toBeGreaterThan(width / 500);
  }
});
