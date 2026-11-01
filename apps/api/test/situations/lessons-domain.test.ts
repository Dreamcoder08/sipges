import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/contexts/situations/domain/settings.ts';
import { attachLessons, findSituations } from '../../src/contexts/situations/domain/situations.ts';
import { moduleForSlug } from '../../src/contexts/records/domain/modules.ts';

const TODAY = '2026-10-19';

/** Synthetic records only. */
const records = [
  {
    module: 'Eventos',
    id: 'EV-1',
    payload: { Fecha: '2026-10-17', Territorio: 'Valle Alto', Descripcion_Hecho: 'Asamblea' },
  },
  {
    module: 'Demandas',
    id: 'D-1',
    payload: { Fecha_Registro: '2026-10-18', Territorio: 'Valle Alto', Tema: 'Agua' },
  },
];
const lesson = (id: string, payload: Record<string, unknown>) => ({
  module: 'Lecciones_Territoriales',
  id,
  payload,
});

describe('Territorial lessons (SIPGES)', () => {
  it('is a records module with its own prefix', () => {
    expect(moduleForSlug('lecciones')).toBe('Lecciones_Territoriales');
  });

  it('attaches past lessons to the situation of the same territory, topic or actor', () => {
    const report = findSituations(records, DEFAULT_SETTINGS, TODAY);
    const [valley] = report.situations;
    expect(valley?.key).toBe('territorio:valle alto');
    const withLessons = attachLessons(report.situations, [
      lesson('LEC-1', {
        Fecha: '2026-03-02',
        Territorio: 'valle alto',
        Aprendido: 'Convocar a la junta de regantes antes de cualquier obra',
      }),
      lesson('LEC-2', { Fecha: '2026-04-01', Territorio: 'Otra Zona', Aprendido: 'No aplica' }),
      lesson('LEC-3', { Fecha: '2026-05-01', Territorio: 'Valle Alto', Aprendido: '' }),
    ]);
    expect(withLessons[0]?.lessons).toEqual([
      {
        id: 'LEC-1',
        date: '2026-03-02',
        learned: 'Convocar a la junta de regantes antes de cualquier obra',
      },
    ]);
  });
});
