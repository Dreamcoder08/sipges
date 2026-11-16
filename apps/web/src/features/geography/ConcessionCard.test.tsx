import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ConcessionCard } from './ConcessionCard.tsx';
import type { Concession } from './concessions.ts';

const concession = {
  code: 'C-SINT-1',
  name: 'Concesión sintética',
  holder: 'Titular sintético',
  hectares: 100,
  status: 'Vigente',
  legend: 'Titulado',
  formulatedAt: '2020-01-15',
  updatedAt: '2026-10-17',
  place: 'Zona sintética',
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ],
  },
  extent: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
  attributes: {},
} as unknown as Concession;

// functional-10 T16: the concession sheet printed GEOCATMIN days as «2020-01-15».
it('dates the concession and its official update in Spanish', () => {
  render(
    <ConcessionCard
      concession={concession}
      source="https://example.invalid/MapServer/0"
      relation={{ status: 'pending', retry: vi.fn() }}
      points={[]}
      relatedOnly={false}
      onRelatedOnly={vi.fn()}
      influence={0}
      onInfluence={vi.fn()}
      onFocusPoint={vi.fn()}
      onFrame={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByText('15 ene. 2020')).toHaveAttribute('datetime', '2020-01-15');
  expect(screen.getByText('17 oct. 2026')).toHaveAttribute('datetime', '2026-10-17');
  expect(document.body).not.toHaveTextContent(/\d{4}-\d{2}-\d{2}/);
});
