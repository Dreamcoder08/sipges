import { expect, it } from 'vitest';
import { projectArea } from './project-area.ts';
import { SECHURA_EXTENT } from './sechura-base.ts';

const TAMBOGRANDE = {
  place: 'Tambogrande, Piura',
  extent: [-80.548, -5.057, -80.218, -4.88] as [number, number, number, number],
};

it('keeps the Sechura province when the project has no location', () => {
  expect(projectArea(null)).toEqual({
    extent: SECHURA_EXTENT,
    place: 'la provincia de Sechura',
    sechura: true,
    all: 'Toda la provincia',
    home: 'Ver toda la provincia',
  });
  expect(projectArea(undefined).sechura).toBe(true);
});

it('frames the project location and leaves the Sechura base out when it lies elsewhere', () => {
  expect(projectArea(TAMBOGRANDE)).toEqual({
    extent: TAMBOGRANDE.extent,
    place: 'Tambogrande, Piura',
    sechura: false,
    all: 'Todo Tambogrande, Piura',
    home: 'Ver Tambogrande, Piura',
  });
});

it('keeps the Sechura base for a location that overlaps the province', () => {
  const area = projectArea({ place: 'Bayóvar, Sechura', extent: [-81.1, -5.9, -80.9, -5.7] });
  expect(area.sechura).toBe(true);
  expect(area.place).toBe('Bayóvar, Sechura');
});
