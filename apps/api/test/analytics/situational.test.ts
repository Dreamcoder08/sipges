import { describe, expect, it } from 'vitest';
import type { StoredRecord } from '../../src/contexts/analytics/domain/records.ts';
import { buildSituational } from '../../src/contexts/analytics/domain/situational.ts';

const AT = '2026-10-12T12:00:00Z';
const rec = (id: string, payload: Record<string, unknown>): StoredRecord => ({ id, payload });

describe('buildSituational (app.py:627)', () => {
  it('counts every record the tenant holds, whatever its Proyecto_ID (S13)', () => {
    const result = buildSituational(
      {
        Eventos: [
          rec('e1', {}),
          rec('e2', { Proyecto_ID: '' }),
          rec('e3', { Proyecto_ID: 'PRJ-OTRO' }),
        ],
        Fuentes: [rec('f1', { Proyecto_ID: 'PRJ-SECHURA' })],
      },
      'PRJ-SECHURA',
      AT,
    );
    expect(result.counts).toEqual({
      eventos: 3,
      actores: 0,
      demandas: 0,
      compromisos: 0,
      narrativas: 0,
      alertas: 0,
      acciones: 0,
      fuentes: 1,
    });
    expect(result.project_id).toBe('PRJ-SECHURA');
    expect(result.project_name).toBe('Proyecto Sechura');
    expect(result.generated_at).toBe(AT);
  });

  it('treats closed states case- and space-insensitively and only counts open items', () => {
    const result = buildSituational(
      {
        Alertas: [
          rec('a1', { Estado: ' Cerrada ' }),
          rec('a2', { Estado: 'RESUELTO' }),
          rec('a3', { Estado: 'Abierta' }),
          rec('a4', {}),
        ],
        Demandas: [rec('d1', { Estado: 'descartado' }), rec('d2', { Estado: 'Pendiente' })],
      },
      'PRJ-SECHURA',
      AT,
    );
    expect(result.alertas_activas).toBe(2);
    expect(result.demandas_pendientes).toBe(1);
    expect(result.observaciones).toEqual([
      'Constan 2 alertas con estado no cerrado; requieren verificación de vigencia, gravedad y responsable.',
      'Se registran 1 demandas no cerradas; revisar competencia y respuesta institucional.',
    ]);
    expect(result.recomendaciones).toHaveLength(4);
  });

  it('aggregates territories as top-8 [name, count] pairs, ties in first-seen order', () => {
    const territories = ['T9', 'T1', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'];
    const result = buildSituational(
      { Eventos: [...territories.map((t, i) => rec(`e${i}`, { Territorio: t })), rec('ex', {})] },
      'PRJ-SECHURA',
      AT,
    );
    expect(result.territorios).toEqual([
      ['T1', 2],
      ['T9', 1],
      ['T2', 1],
      ['T3', 1],
      ['T4', 1],
      ['T5', 1],
      ['T6', 1],
      ['T7', 1],
    ]);
    expect(result.eventos_recientes).toHaveLength(8);
    expect(result.eventos_recientes[0]).toEqual({
      Fecha: '',
      Territorio: 'T9',
      Descripcion_Hecho: '',
      Nivel_Verificacion: '',
      Fuente_ID: '',
      id: 'e0',
    });
  });

  it('labels missing values, levels and sorts priority alerts by color', () => {
    const result = buildSituational(
      {
        Eventos: [rec('e1', { Territorio: '' })],
        Demandas: [rec('d1', {})],
        Alertas: [
          rec('a1', { Nivel_Preliminar: 'Verde' }),
          rec('a2', { Nivel: 'Medio' }),
          rec('a3', { Nivel_Preliminar: 'ROJO' }),
        ],
      },
      'PRJ-SECHURA',
      AT,
    );
    expect(result.territorios).toEqual([['Sin precisar', 1]]);
    expect(result.temas_demanda).toEqual([['Sin tema', 1]]);
    expect(result.niveles_alerta).toEqual([
      ['Verde', 1],
      ['Medio', 1],
      ['ROJO', 1],
    ]);
    expect(result.alertas_prioritarias.map((x) => x.id)).toEqual(['a3', 'a1', 'a2']);
  });

  it('reports insufficient signals and uses the project record name when present', () => {
    const empty = buildSituational(
      { Proyectos: [rec('p', { Proyecto_ID: 'PRJ-NORTE', Nombre: 'Norte' })] },
      'PRJ-NORTE',
      AT,
    );
    expect(empty.project_name).toBe('Norte');
    expect(empty.observaciones).toEqual([
      'No hay señales suficientes para emitir conclusiones sustantivas con esta base de datos.',
    ]);
    expect(empty.recomendaciones).toEqual([
      'Validar el diagnóstico con el equipo territorial y registrar fecha, fuentes y analista responsable.',
      'Aplicar seguimiento periódico y documentar cambios frente al corte anterior.',
    ]);
    expect(buildSituational({}, 'PRJ-X', AT).project_name).toBe('PRJ-X');
  });

  it('names the project from the tenant label when no Proyectos record exists', () => {
    expect(buildSituational({}, 'PRJ-NORTE', AT, 'Proyecto Norte').project_name).toBe(
      'Proyecto Norte',
    );
    const named = buildSituational(
      { Proyectos: [rec('p', { Proyecto_ID: 'PRJ-NORTE', Nombre: 'Norte' })] },
      'PRJ-NORTE',
      AT,
      'Proyecto Norte',
    );
    expect(named.project_name).toBe('Norte');
    expect(
      buildSituational({}, 'PRJ-SECHURA', AT, 'Proyecto Sechura (migración)').project_name,
    ).toBe('Proyecto Sechura');
  });

  it('notes narratives without treating them as evidence', () => {
    const result = buildSituational({ Narrativas: [rec('n1', {})] }, 'PRJ-SECHURA', AT);
    expect(result.observaciones).toEqual([
      'Existen 1 narrativas registradas; su contenido no constituye por sí mismo prueba de un hecho.',
    ]);
    expect(result.recomendaciones[0]).toBe(
      'Contrastar narrativas con fuentes independientes antes de atribuir hechos o responsabilidades.',
    );
  });
});
