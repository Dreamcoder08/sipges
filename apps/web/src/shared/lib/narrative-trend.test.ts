import { describe, expect, it } from 'vitest';
import {
  narrativeCategory,
  narrativeDate,
  narrativeDay,
  narrativeTrend,
  parseDay,
} from './narrative-trend.ts';

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

describe('parseDay', () => {
  it('reads ISO dates with a time and zone, keeping the written day', () => {
    expect(parseDay('2026-10-03T23:30:00-05:00')).toBe('2026-10-03');
    expect(parseDay('2026-10-03 08:15')).toBe('2026-10-03');
  });
  it('reads day-month-year with dashes', () => {
    expect(parseDay('5-10-2026')).toBe('2026-10-05');
  });
  it('reads day.month.year with dots', () => {
    expect(parseDay('05.10.2026')).toBe('2026-10-05');
  });
  it('reads year/month/day with slashes', () => {
    expect(parseDay('2026/10/05')).toBe('2026-10-05');
  });
  it('reads Spanish month abbreviations', () => {
    expect(parseDay('15 oct 2026')).toBe('2026-10-15');
    expect(parseDay('3-Set-2026')).toBe('2026-09-03');
    expect(parseDay('1 dic. 2026')).toBe('2026-12-01');
  });
  it('reads Spanish month names with «de»', () => {
    expect(parseDay('15 de octubre de 2026')).toBe('2026-10-15');
    expect(parseDay('2 de Setiembre del 2026')).toBe('2026-09-02');
    expect(parseDay('Miércoles, 7 de enero de 2026')).toBe('2026-01-07');
  });
  it('reads Excel serial day numbers, as number or text', () => {
    expect(parseDay(46310)).toBe('2026-10-15');
    expect(parseDay('46310')).toBe('2026-10-15');
    expect(parseDay(46310.75)).toBe('2026-10-15');
  });
  it('rejects impossible or unreadable dates', () => {
    expect(parseDay('31/02/2026')).toBeNull();
    expect(parseDay('15 foo 2026')).toBeNull();
    expect(parseDay('sin fecha')).toBeNull();
    expect(parseDay(12)).toBeNull();
    expect(parseDay('')).toBeNull();
  });
});

describe('narrativeDate', () => {
  it('falls back to «Fecha» and «Fecha_Registro» after publication and observation', () => {
    expect(narrativeDate(row('a', { Fecha: '15 oct 2026' }))).toEqual({
      day: '2026-10-15',
      field: 'Fecha',
    });
    expect(narrativeDate(row('b', { Fecha_Registro: '2026/10/16' }))).toEqual({
      day: '2026-10-16',
      field: 'Fecha_Registro',
    });
    expect(
      narrativeDate(row('c', { Fecha_Inicio: 'pendiente', Fecha_Observacion: '04.10.2026' })),
    ).toEqual({ day: '2026-10-04', field: 'Fecha_Observacion' });
  });
  it('uses the last-change timestamp only as last resort', () => {
    expect(
      narrativeDate(row('d', { Fecha_Inicio: '01/10/2026', _updated_at: '2026-11-01T10:00:00Z' })),
    ).toEqual({ day: '2026-10-01', field: 'Fecha_Inicio' });
    expect(narrativeDate(row('e', { _updated_at: '2026-11-01T10:00:00Z' }))).toEqual({
      day: '2026-11-01',
      field: '_updated_at',
    });
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
  it('charts narratives whose dates come in non-ISO shapes', () => {
    const trend = narrativeTrend(
      [
        row('1', { Fecha_Inicio: '1 de octubre de 2026', Tema: 'agua' }),
        row('2', { Fecha_Inicio: '03-10-2026', Tema: 'agua' }),
        row('3', { Fecha_Inicio: 46300, Tema: 'agua' }),
      ],
      30,
    );
    expect(trend.total).toBe(3);
    expect(trend.datedDays).toBe(3);
    expect(trend.undated).toBe(0);
  });
  it('counts narratives left out for lacking a usable date and those placed on their last change', () => {
    const trend = narrativeTrend(
      [
        row('1', { Fecha_Inicio: '2026-10-01' }),
        row('2', { Fecha_Inicio: 'sin dato' }),
        row('3', {}),
        row('4', { _updated_at: '2026-10-02T09:00:00Z' }),
      ],
      30,
    );
    expect(trend.undated).toBe(2);
    expect(trend.fromUpdate).toBe(1);
    expect(trend.total).toBe(2);
    expect(trend.datedDays).toBe(2);
  });
  it('summarises every narrative by category, dated or not, with the category fallback unchanged', () => {
    const trend = narrativeTrend(
      [
        row('1', { Categoria: 'G - Gobernanza', Tema: 'agua' }),
        row('2', { Tema: 'Contaminación del agua' }),
        row('3', { Tema: 'Publicación viral' }),
        row('4', { Fecha_Inicio: '2026-10-01', Tema: 'agua' }),
      ],
      30,
    );
    expect(trend.datedDays).toBe(1);
    expect(trend.byCategory).toEqual([
      { code: 'E', label: 'Medio ambiente', value: 2 },
      { code: 'G', label: 'Gobernanza', value: 1 },
      { code: 'N', label: 'Narrativas y señales digitales', value: 1 },
    ]);
  });
  it('anchors the window on real dates, not on last-change days', () => {
    const trend = narrativeTrend(
      [
        row('1', { Fecha_Inicio: '2026-03-01', Tema: 'agua' }),
        row('2', { Fecha_Inicio: '2026-03-05', Tema: 'agua' }),
        row('3', { _updated_at: '2026-11-01T10:00:00Z' }),
      ],
      30,
    );
    expect(trend.days.at(-1)).toBe('2026-03-05');
    expect(trend.total).toBe(2);
    expect(trend.fromUpdate).toBe(1);
  });
});
