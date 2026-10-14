import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SECHURA_EXTENT } from './sechura-base.ts';
import { cadastreUrl, MiningCadastreLayer } from './MiningCadastreLayer.tsx';

it('asks GEOCATMIN for one transparent cadastre image of the view, without credentials', () => {
  const url = new URL(cadastreUrl(SECHURA_EXTENT));
  expect(url.origin).toBe('https://geocatmin.ingemmet.gob.pe');
  expect(url.pathname).toBe('/arcgis/rest/services/SERV_CATASTRO_MINERO/MapServer/export');
  expect(url.searchParams.get('bbox')).toBe(SECHURA_EXTENT.join(','));
  expect(url.searchParams.get('bboxSR')).toBe('4326');
  expect(url.searchParams.get('imageSR')).toBe('4326');
  expect(url.searchParams.get('transparent')).toBe('true');
  expect(url.searchParams.get('f')).toBe('image');
  expect(url.username + url.password).toBe('');
  const { container } = render(
    <svg>
      <MiningCadastreLayer view={SECHURA_EXTENT} />
    </svg>,
  );
  expect(container.querySelector('image')?.getAttribute('href')).toBe(url.href);
});
