import { describe, expect, it } from 'vitest';
import {
  concessionsOf,
  esriDate,
  esriRingsToGeoJson,
  queryExtent,
  relationPolygon,
} from './concessions.ts';

// Synthetic concession geometry (not an official record): a clockwise square with a hole.
const shell = [
  [-80.9, -5.5],
  [-80.8, -5.5],
  [-80.8, -5.6],
  [-80.9, -5.6],
  [-80.9, -5.5],
];
const hole = [
  [-80.87, -5.53],
  [-80.87, -5.57],
  [-80.83, -5.57],
  [-80.83, -5.53],
  [-80.87, -5.53],
];

describe('INGEMMET concessions', () => {
  it('turns Esri rings into GeoJSON exteriors and holes', () => {
    const geometry = esriRingsToGeoJson({ rings: [shell, hole] });
    expect(geometry?.type).toBe('Polygon');
    if (geometry?.type !== 'Polygon') throw new Error('Polygon expected');
    expect(geometry.coordinates).toHaveLength(2);
    // RFC 7946: counter-clockwise exterior.
    expect(geometry.coordinates[0]?.[1]).toEqual([-80.9, -5.6]);
  });

  it('keeps separate parts as a MultiPolygon and drops invalid rings', () => {
    const other = shell.map(([x, y]) => [(x ?? 0) + 0.3, y ?? 0]);
    const geometry = esriRingsToGeoJson({ rings: [shell, other, [[1, 2]], 'x'] });
    expect(geometry?.type).toBe('MultiPolygon');
    expect(esriRingsToGeoJson({ rings: [] })).toBeNull();
    expect(esriRingsToGeoJson(null)).toBeNull();
  });

  it('reads the official attributes and deduplicates by code', () => {
    const feature = {
      attributes: {
        CODIGOU: 'SINT-0001',
        CONCESION: 'CONCESION SINTETICA',
        TIT_CONCES: 'TITULAR DE PRUEBA S.A.C.',
        HECTAGIS: 100.5,
        D_ESTADO: 'D.M. TITULADO',
        LEYENDA: 'TITULADO',
        FEC_DENU: Date.UTC(2020, 0, 15, 12),
        DISTRI: 'SECHURA',
        PROVI: 'SECHURA',
        DEPA: 'PIURA',
      },
      geometry: { rings: [shell] },
    };
    const [concession, ...rest] = concessionsOf([feature, feature, { attributes: {} }]);
    expect(rest).toHaveLength(0);
    expect(concession).toMatchObject({
      code: 'SINT-0001',
      holder: 'TITULAR DE PRUEBA S.A.C.',
      hectares: 100.5,
      legend: 'TITULADO',
      formulatedAt: '2020-01-15',
      place: 'SECHURA, SECHURA, PIURA',
      extent: [-80.9, -5.6, -80.8, -5.5],
    });
    expect(esriDate('x')).toBe('');
  });

  it('relates by the official polygon only when it fits the API contract', () => {
    const [concession] = concessionsOf([
      { attributes: { CODIGOU: 'A' }, geometry: { rings: [shell, hole] } },
    ]);
    if (!concession) throw new Error('concession expected');
    expect(relationPolygon(concession)?.coordinates).toHaveLength(2);
    const dense = Array.from({ length: 600 }, (_, i) => {
      const a = (-2 * Math.PI * i) / 600;
      return [-80.8 + 0.05 * Math.cos(a), -5.5 + 0.05 * Math.sin(a)];
    });
    const [big] = concessionsOf([
      { attributes: { CODIGOU: 'B' }, geometry: { rings: [[...dense, dense[0]]] } },
    ]);
    if (!big) throw new Error('concession expected');
    expect(relationPolygon(big)).toBeNull();
  });

  it('keeps cadastre queries within five degrees per axis', () => {
    const [a, b, c, d] = queryExtent([-90, -15, -70, -2]);
    expect(c - a).toBeLessThanOrEqual(5);
    expect(d - b).toBeLessThanOrEqual(5);
    expect(queryExtent([-81, -6, -80, -5])).toEqual([-81, -6, -80, -5]);
  });
});
