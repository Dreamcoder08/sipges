import { describe, expect, it } from 'vitest';
import { narrativeCategory, narrativeDay, narrativeTrend } from './narrative-trend.ts';

const row = (id: string, payload: Record<string, unknown>) => ({ _id: id, ...payload });

describe('narrativeCategory', () => {
  it('uses the «Categoría» field first', () => {
    expect(narrativeCategory(row('N-1', { Categoria: 'G - Gobernanza y representación' }))).toBe(
      'G',
    );
  });
  it('infers the category from topic and description, N when nothing matches', () => {
    expect(narrativeCategory(row('N-2', { Tema: 'Contaminación del agua en la bahía' }))).toBe('E');
    expect(
      narrativeCategory(row('N-3', { Descripcion: 'Exigen empleo local y compromisos' })),
    ).toBe('D');
    expect(narrativeCategory(row('N-4', { Tema: 'Publicación viral en Facebook' }))).toBe('N');
  });
});

describe('narrativeDay', () => {
  it('reads ISO and day/month/year dates, publication first', () => {
    expect(narrativeDay(row('a', { Fecha_Inicio: '2026-10-03T10:00' }))).toBe('2026-10-03');
    expect(narrativeDay(row('b', { Fecha_Observacion: '4/10/2026' }))).toBe('2026-10-04');
    expect(narrativeDay(row('c', {}))).toBeNull();
  });
});

describe('narrativeTrend', () => {
  it('counts narratives per day and category with zero-filled days', () => {
    const trend = narrativeTrend(
      [
        row('1', { Fecha_Inicio: '2026-10-01', Tema: 'agua' }),
        row('2', { Fecha_Inicio: '2026-10-01', Tema: 'pesca artesanal' }),
        row('3', { Fecha_Inicio: '2026-10-08', Tema: 'demanda de empleo' }),
        row('4', { Tema: 'sin fecha' }),
      ],
      30,
    );
    expect(trend.days).toHaveLength(8);
    expect(trend.days[0]).toBe('2026-10-01');
    expect(trend.total).toBe(3);
    expect(trend.undated).toBe(1);
    expect(trend.series.map((s) => s.code)).toEqual(['E', 'G', 'D', 'A', 'N']);
    expect(trend.series.find((s) => s.code === 'E')?.values[0]).toBe(2);
    expect(trend.series.find((s) => s.code === 'D')?.values[7]).toBe(1);
  });
  it('limits the window to the latest days and shows at least a week', () => {
    const rows = [
      row('1', { Fecha_Inicio: '2026-01-01' }),
      row('2', { Fecha_Inicio: '2026-10-15' }),
    ];
    expect(narrativeTrend(rows, 30).days).toHaveLength(30);
    expect(narrativeTrend(rows, 30).total).toBe(1);
    expect(narrativeTrend(rows.slice(1), 'todo').days).toHaveLength(7);
  });
});
