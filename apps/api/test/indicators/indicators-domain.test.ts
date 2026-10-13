import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IRSA_CONFIG,
  type IndicatorsReport,
  type ModuleRecords,
  applyIrsaConfigPatch,
  computeIndicators,
  computeIrsa,
  pyRound,
  selectBand,
} from '../../src/contexts/indicators/domain/index.ts';
import parity from './python-parity.fixture.json' with { type: 'json' };

const EMPTY: ModuleRecords = {
  Eventos: [],
  Actores: [],
  Demandas: [],
  Compromisos: [],
  Narrativas: [],
  Alertas: [],
  Acciones: [],
  Directorio_Territorial: [],
};

/** Minimal report with chosen dimension scores and indicator scores (synthetic). */
const report = (
  scores: Record<string, number>,
  indicatorScores: (number | null)[] = [],
): IndicatorsReport => {
  const base = computeIndicators(EMPTY);
  const [template] = base.indicators;
  if (!template) throw new Error('expected indicators');
  const indicators = indicatorScores.map((score, i) => ({
    ...template,
    code: `X${i}`,
    name: `Indicator ${i}`,
    score,
  }));
  return { ...base, dimension_scores: { ...base.dimension_scores, ...scores }, indicators };
};

describe('computeIndicators (app.py compute_indicators v0.4)', () => {
  it('returns 32 indicators across G/A/D/N/E/I with metadata and a null A3', () => {
    const result = computeIndicators(EMPTY);
    expect(result.indicators).toHaveLength(32);
    expect(
      Object.fromEntries(Object.entries(result.dimensions).map(([d, v]) => [d, v.length])),
    ).toEqual({ G: 5, A: 6, D: 5, N: 5, E: 5, I: 6 });
    const a3 = result.indicators.find((x) => x.code === 'A3');
    expect(a3).toMatchObject({
      score: null,
      confidence: 'Baja',
      availability: 'Datos insuficientes',
      dimension: 'A',
      dimension_label: 'Actores e influencia',
      evidence_count: 0,
    });
    expect(a3?.name).toBeTypeOf('string');
    expect(Object.keys(result.indicators[0] ?? {})).toEqual([
      'code',
      'score',
      'confidence',
      'method',
      'evidence_count',
      'explanation',
      'availability',
      'name',
      'definition',
      'dimension',
      'dimension_label',
    ]);
    expect(result.validation_status).toBe('PROVISIONAL / PENDIENTE DE VALIDACIÓN DE EXPERTOS');
  });

  it('scores an empty base as zero except the inverse-coverage indicators I5 and I6', () => {
    const result = computeIndicators(EMPTY);
    expect(result.dimension_scores).toEqual({ G: 0, A: 0, D: 0, N: 0, E: 0, I: 33.33 });
    // A3 is excluded from availability: 5 of 6 indicators.
    expect(result.availability).toEqual({ G: 100, A: 83.3, D: 100, N: 100, E: 100, I: 100 });
  });

  it('averages each dimension over its non-null indicators only', () => {
    const actor = {
      _id: 'a1',
      Influencia: 'Alta',
      Posicion_Proyecto: 'Crítica',
      Capacidad_Movilizacion: 'Alta',
      'Legitimidad/Representacion': 'Por validar',
    };
    const result = computeIndicators({ ...EMPTY, Actores: [actor] });
    const scores = Object.fromEntries(result.dimensions.A.map((x) => [x.code, x.score]));
    expect(scores).toEqual({ A1: 100, A2: 100, A3: null, A4: 0, A5: 100, A6: 0 });
    // (100 + 100 + 0 + 100 + 0) / 5, A3 excluded.
    expect(result.dimension_scores.A).toBe(60);
  });

  it('applies the text and state rules of app.py to synthetic records', () => {
    const result = computeIndicators({
      ...EMPTY,
      Demandas: [
        { Estado: 'Abierta', Recurrencia: 'Alta', Dimension: 'E - Ambiental', Tema: 'Agua' },
        { Estado: 'Cerrada', Recurrencia: 'Baja', Tema: 'Empleo' },
      ],
      Alertas: [
        { ID_Alerta: 'AL-1', Dimension: 'I', Estado: 'Activa', Responsable: 'Por asignar' },
      ],
      Acciones: [{ ID_Alerta: 'AL-1', Estado: 'Pendiente', Evidencia: 'acta' }],
    });
    const by = Object.fromEntries(result.indicators.map((x) => [x.code, x]));
    expect(by.D1?.score).toBe(7);
    expect(by.D2?.score).toBe(50);
    expect(by.E2?.score).toBe(100);
    expect(by.I1).toMatchObject({ score: 26, evidence_count: 2 });
    expect(by.I4?.score).toBe(100);
    // 1 of 4 key records (2 demands, 1 alert, 1 action) has evidence: 100 - 25.
    expect(by.I5?.score).toBe(75);
  });
});

describe('computeIrsa', () => {
  it('weights dimension scores and rounds the IRSA to 2 decimals', () => {
    const config = {
      ...DEFAULT_IRSA_CONFIG,
      weights: { G: 0.5, A: 0.5, D: 0, N: 0, E: 0, I: 0 },
    };
    const result = computeIrsa(config, report({ G: 33.333, A: 10, I: 0 }));
    expect(result.irsa).toBe(21.67);
    expect(result.level).toBe('Verde');
    expect(result.config_version).toBe('0.4-indicators');
    expect(result.weights).toEqual(config.weights);
    expect(result.thresholds).toEqual(config.thresholds);
  });

  it('uses the first band containing the IRSA and falls back to Rojo in band gaps', () => {
    const t = DEFAULT_IRSA_CONFIG.thresholds;
    expect(selectBand(0, t)).toBe('Verde');
    expect(selectBand(30, t)).toBe('Amarillo');
    expect(selectBand(74.99, t)).toBe('Naranja');
    expect(selectBand(24.995, t)).toBe('Rojo');
    expect(selectBand(10, { Primera: [0, 50], Segunda: [0, 100] })).toBe('Primera');
    expect(selectBand(120, { Verde: [0, 100] })).toBe('Rojo');
  });

  it('returns the 15 highest non-null indicators as drivers, highest first', () => {
    const scores = [null, ...Array.from({ length: 20 }, (_, i) => i * 5)];
    const result = computeIrsa(DEFAULT_IRSA_CONFIG, report({}, scores));
    expect(result.drivers).toHaveLength(15);
    expect(result.drivers.map((d) => d.points)).toEqual(
      Array.from({ length: 15 }, (_, i) => 95 - i * 5),
    );
    expect(result.drivers[0]).toEqual({
      dimension: 'G',
      dimension_label: 'Gobernanza y representación',
      type: 'indicador',
      id: 'X20',
      label: 'Indicator 20',
      points: 95,
      confidence: 'Media-Alta',
      explanation: expect.any(String),
    });
  });

  it('computes the empty-base IRSA from the default configuration', () => {
    const result = computeIrsa(DEFAULT_IRSA_CONFIG, computeIndicators(EMPTY));
    // 33.33 × 0.1666665 = 5.554994…; Python round() gives 5.55
    expect(result.irsa).toBe(5.55);
    expect(result.level).toBe('Verde');
    expect(result.drivers.map((d) => d.id).slice(0, 2)).toEqual(['I5', 'I6']);
    expect(result.notes).toHaveLength(3);
  });
});

describe('applyIrsaConfigPatch', () => {
  it('rejects weights that do not sum to 1 within 0.02', () => {
    expect(applyIrsaConfigPatch(DEFAULT_IRSA_CONFIG, { weights: { G: 0.9 } }).ok).toBe(false);
    expect(applyIrsaConfigPatch(DEFAULT_IRSA_CONFIG, { weights: { G: 0.5, A: 0.53 } }).ok).toBe(
      false,
    );
  });

  it('replaces weights over every dimension, thresholds wholesale and merges contributions', () => {
    const result = applyIrsaConfigPatch(DEFAULT_IRSA_CONFIG, {
      weights: { G: 0.5, A: 0.51, Z: 3 },
      thresholds: { Bajo: [0, 50], Alto: [50.01, 100] },
      contributions: { active_alert: 20, new_rule: 1 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.weights).toEqual({ G: 0.5, A: 0.51, D: 0, N: 0, E: 0, I: 0 });
    expect(result.value.thresholds).toEqual({ Bajo: [0, 50], Alto: [50.01, 100] });
    expect(result.value.contributions).toMatchObject({
      active_alert: 20,
      open_demand: 7,
      new_rule: 1,
    });
    expect(result.value.notes).toEqual(DEFAULT_IRSA_CONFIG.notes);
  });
});

describe('pyRound', () => {
  it('matches Python round() on binary ties and representation error', () => {
    expect(pyRound(0.125, 2)).toBe(0.12);
    expect(pyRound(0.375, 2)).toBe(0.38);
    expect(pyRound(2.675, 2)).toBe(2.67);
    expect(pyRound(83.33333, 1)).toBe(83.3);
  });
});

describe('Python parity', () => {
  it('reproduces app.py compute_indicators on a synthetic multi-module dataset', () => {
    const result = computeIndicators(parity.records as unknown as ModuleRecords);
    expect(result.dimension_scores).toEqual(parity.expected.dimension_scores);
    expect(result.availability).toEqual(parity.expected.availability);
    expect(
      result.indicators.map((x) => [x.code, x.score, x.evidence_count, x.explanation]),
    ).toEqual(parity.expected.indicators);
  });
});
