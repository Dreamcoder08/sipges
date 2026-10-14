import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SECHURA_EXTENT } from './sechura-base.ts';
import { TileLayer } from './TileLayer.tsx';

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
