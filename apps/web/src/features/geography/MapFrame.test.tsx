import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
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

it('zooms with Ctrl + wheel and leaves a plain wheel to the page', () => {
  render(<Harness />);
  const map = screen.getByRole('group', { name: 'Mapa' });
  fireEvent.wheel(map, { deltaY: -200 });
  expect(box()[2]).toBeCloseTo(1);
  fireEvent.wheel(map, { deltaY: -200, ctrlKey: true });
  expect(box()[2]).toBeLessThan(1);
});
