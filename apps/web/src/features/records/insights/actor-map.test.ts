import { expect, it } from 'vitest';
import { CARD, layoutActors, MAP, relationOf, sectorOf } from './actor-map.ts';

it('uses the recorded sector and otherwise infers it from the type or the name', () => {
  expect(sectorOf({ _id: 'A', Sector: 'academia', Tipo_Actor: 'Empresa' })).toEqual({
    sector: 'Academia',
    inferred: false,
  });
  expect(sectorOf({ _id: 'A', Tipo_Actor: 'Autoridad local' }).sector).toBe('Gobierno');
  expect(sectorOf({ _id: 'A', Tipo_Actor: 'Productivo' }).sector).toBe('Privado');
  expect(
    sectorOf({
      _id: 'A',
      Tipo_Actor: 'Institucional',
      'Nombre_Actor/Organizacion': 'Cámara de Comercio de prueba',
    }).sector,
  ).toBe('Privado');
  expect(sectorOf({ _id: 'A', Tipo_Actor: 'Comunal' }).sector).toBe('Sociedad civil');
  expect(sectorOf({ _id: 'A', Tipo_Actor: 'Institucional' }).sector).toBe('Gobierno');
  expect(sectorOf({ _id: 'A', Tipo_Actor: 'Otro' })).toEqual({ sector: null, inferred: true });
});

it('reads the optional relation fields without inventing them', () => {
  expect(
    relationOf({ _id: 'A', Tipo_Relacion: 'Débil', Sentido_Relacion: 'Del actor al proyecto' }),
  ).toEqual({ strength: 'debil', direction: 'actor' });
  expect(relationOf({ _id: 'A' })).toEqual({ strength: null, direction: null });
});

it('keeps every actor in its ring and sector without overlapping cards', () => {
  const rows = Array.from({ length: 30 }, (_, n) => ({
    _id: `A-${n}`,
    'Nombre_Actor/Organizacion': `Actor ${n}`,
    Tipo_Actor: ['Comunidad', 'Autoridad local', 'Productivo', 'Universidad'][n % 4],
    Influencia: ['Alta', 'Media-Alta', 'Media', 'Baja', ''][n % 5],
  }));
  const { actors: placed, scale } = layoutActors(rows);
  expect(placed).toHaveLength(30);
  expect(placed.find((a) => a.row._id === 'A-0')).toMatchObject({
    ring: 0,
    sector: 'Sociedad civil',
  });
  expect(placed.find((a) => a.row._id === 'A-1')).toMatchObject({ ring: 1, sector: 'Gobierno' });
  expect(placed.find((a) => a.row._id === 'A-4')).toMatchObject({ ring: 2, band: null });
  const quadrant = {
    Gobierno: [-1, -1],
    Privado: [1, -1],
    'Sociedad civil': [1, 1],
    Academia: [-1, 1],
  };
  for (const actor of placed) {
    const [sx, sy] = quadrant[actor.sector];
    expect([Math.sign(actor.x - MAP.cx), Math.sign(actor.y - MAP.cy)]).toEqual([sx, sy]);
  }
  const overlaps = placed.flatMap((a, i) =>
    placed
      .slice(i + 1)
      .filter(
        (b) =>
          Math.abs(a.x - b.x) < CARD.width * scale - 1 &&
          Math.abs(a.y - b.y) < CARD.height * scale - 1,
      ),
  );
  expect(overlaps).toEqual([]);
  expect(layoutActors(rows).actors).toEqual(placed);
});
