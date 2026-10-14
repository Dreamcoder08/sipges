import { fireEvent, render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SECHURA_EXTENT } from './sechura-base.ts';
import { BASEMAPS, TileLayer, tilesFor } from './TileLayer.tsx';

it('uses the canonical public OSM tile service without credentials or query tokens', () => {
  const { container } = render(
    <svg>
      <TileLayer view={SECHURA_EXTENT} />
    </svg>,
  );
  const images = [...container.querySelectorAll('image')];
  expect(images.length).toBeGreaterThan(0);
  for (const image of images) {
    const url = new URL(image.getAttribute('href') ?? '');
    expect(url.origin).toBe('https://tile.openstreetmap.org');
    expect(url.pathname).toMatch(/^\/\d+\/\d+\/\d+\.png$/);
    expect(url.search).toBe('');
    expect(url.username + url.password).toBe('');
  }
});

it('draws Sentinel-2 cloudless imagery from EOX, stretching its deepest level up close', () => {
  const { container } = render(
    <svg>
      <TileLayer view={SECHURA_EXTENT} basemap="satelite" />
    </svg>,
  );
  const images = [...container.querySelectorAll('image')];
  expect(images.length).toBeGreaterThan(0);
  for (const image of images) {
    const url = new URL(image.getAttribute('href') ?? '');
    expect(url.origin).toBe('https://tiles.maps.eox.at');
    expect(url.pathname).toMatch(
      /^\/wmts\/1\.0\.0\/s2cloudless-2020_3857\/default\/g\/\d+\/\d+\/\d+\.jpg$/,
    );
    expect(url.search).toBe('');
  }
  const close = tilesFor([-80.9, -5.6, -80.895, -5.595], BASEMAPS.satelite);
  expect(close.zoom).toBe(14);
  expect(close.tiles.length).toBeGreaterThan(0);
});

it('draws nothing without a basemap', () => {
  const { container } = render(
    <svg>
      <TileLayer view={SECHURA_EXTENT} basemap="ninguno" />
    </svg>,
  );
  expect(container.querySelectorAll('image')).toHaveLength(0);
});

it('keeps the previous level under the new one until its tiles load', () => {
  const near: [number, number, number, number] = [-80.9, -5.7, -80.8, -5.6];
  const { container, rerender } = render(
    <svg>
      <TileLayer view={SECHURA_EXTENT} />
    </svg>,
  );
  const first = [...container.querySelectorAll('image')];
  for (const image of first) fireEvent.load(image);
  rerender(
    <svg>
      <TileLayer view={near} />
    </svg>,
  );
  const hrefs = () => [...container.querySelectorAll('image')].map((i) => i.getAttribute('href'));
  expect(hrefs()).toEqual(expect.arrayContaining(first.map((i) => i.getAttribute('href'))));
  const fresh = tilesFor(near, BASEMAPS.calles).tiles;
  for (const tile of fresh)
    fireEvent.load(container.querySelector(`image[href="${tile.href}"]`) as Element);
  expect(hrefs()).toHaveLength(fresh.length);
});
