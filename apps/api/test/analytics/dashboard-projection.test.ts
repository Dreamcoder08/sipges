import { describe, expect, it } from 'vitest';
import { createSqlDashboardRecordReader } from '../../src/contexts/analytics/infrastructure/sql-dashboard-record-reader.ts';
import { createTestApp } from '../support/test-app.ts';

const SCOPE = { companyId: 'MASCLI', projectId: 'PRJ-SECHURA' };

describe('dashboard SQL projection', () => {
  it('materializes only raw dashboard values, preserving row order and JSON types', async () => {
    const t = await createTestApp();
    // Synthetic legacy values may predate current HTTP validation.
    for (const [id, module, payload] of [
      ['e1', 'Eventos', { Estado: 'ignored', Descripcion: 'x'.repeat(4096) }],
      ['d1', 'Demandas', { Estado: false, Nivel: 'ignored', Extra: 'x'.repeat(4096) }],
      [
        'a1',
        'Alertas',
        { Estado: null, Nivel_Preliminar: [], Nivel: { raw: true }, Extra: 'x'.repeat(4096) },
      ],
      ['a2', 'Alertas', { Nivel_Preliminar: 0, Nivel: false }],
    ] as const) {
      await t.sql.query(
        `INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $5)`,
        [
          'MASCLI/PRJ-SECHURA',
          module,
          id,
          JSON.stringify(payload),
          `2026-01-0${id === 'a2' ? 2 : 1}T00:00:00Z`,
        ],
      );
    }
    const reader = createSqlDashboardRecordReader(t.sql);
    expect(await reader.read(SCOPE, ['Eventos', 'Demandas', 'Alertas', 'Actores'])).toEqual({
      Eventos: [{ id: 'e1', payload: {} }],
      Demandas: [{ id: 'd1', payload: { Estado: false } }],
      Alertas: [
        { id: 'a2', payload: { Estado: null, Nivel_Preliminar: 0, Nivel: false } },
        { id: 'a1', payload: { Estado: null, Nivel_Preliminar: [], Nivel: { raw: true } } },
      ],
      Actores: [],
    });
  });

  it('keeps the empty and forced-RLS refusal contracts', async () => {
    const t = await createTestApp();
    const reader = createSqlDashboardRecordReader(t.sql);
    expect(await reader.read(SCOPE, [])).toEqual({});
    await t.sql.exec('ALTER TABLE module_records NO FORCE ROW LEVEL SECURITY');
    await expect(reader.read(SCOPE, ['Eventos'])).rejects.toThrow(
      'Analytics requires forced tenant row-level security',
    );
  });
});
