import {
  type Band,
  type Confidence,
  type Platt,
  type Sample,
  brier,
  fitPlatt,
  probability,
  probabilityBand,
  reliabilityBins,
  roundProbability,
  signalBand,
} from './calibration.ts';
import {
  type Factor,
  assertNoLeakage,
  escalatedWithin,
  featuresAt,
  recentSignals,
  scoreOf,
} from './features.ts';
import { type RiskInput, type SignalIndex, addDays, indexSignals } from './signals.ts';

export const HORIZONS = [30, 90] as const;
export type Horizon = (typeof HORIZONS)[number];

const CUTOFF_STEP = 30;
const MAX_CUTOFFS = 24;
const MIN_HISTORY = 90;
const MIN_TRAIN_EVENTS = 5;
const MIN_TRAIN_SAMPLES = 30;
const MIN_TEST_SAMPLES = 10;
const MAX_UNITS = 50;

export const METHOD =
  'Puntaje transparente de factores con pesos fijos, calibrado con el historial del propio proyecto (ADR 0031). Se calcula dentro de SIPGES, sin IA externa.';

const LIMITATIONS = [
  'Es una ayuda para priorizar, no un pronóstico de hechos: la probabilidad tiene el error que muestra el back-test.',
  'Solo cuenta lo que el proyecto registró; la falta de registros no demuestra ausencia de riesgo.',
  'El IRSA se mide por proyecto, así que sube o baja el riesgo de todas las localidades y actores por igual.',
  'Validar con el equipo territorial antes de decidir o comunicar.',
];

type BacktestPair = { p: number; y: boolean };

export type Backtest = {
  readonly horizon: Horizon;
  readonly calibrated: boolean;
  /** Why there is no calibration, with the sample size; null when calibrated. */
  readonly reason: string | null;
  readonly cutoffs: number;
  readonly from: string | null;
  readonly to: string | null;
  readonly train: { readonly samples: number; readonly events: number };
  readonly test: { readonly samples: number; readonly events: number };
  readonly brier: number | null;
  /** Brier score of the training base rate on the test samples. */
  readonly brierReference: number | null;
  /** `1 − brier / brierReference`; above 0 beats the base rate. */
  readonly skill: number | null;
  readonly bins: ReturnType<typeof reliabilityBins>;
};

type Calibration = { readonly backtest: Backtest; readonly platt: Platt | null };

const round3 = (value: number | null) => (value === null ? null : Math.round(value * 1000) / 1000);

/** Cut-offs every 30 days back from `today − horizon`, oldest first, each with 90 days before it. */
const cutoffsFor = (index: SignalIndex, today: string, horizon: Horizon) => {
  if (!index.firstDay) return [];
  const earliest = addDays(index.firstDay, MIN_HISTORY);
  const cutoffs: string[] = [];
  for (let k = 0; k < MAX_CUTOFFS; k += 1) {
    const t = addDays(today, -horizon - CUTOFF_STEP * k);
    if (t < earliest) break;
    cutoffs.push(t);
  }
  return cutoffs.reverse();
};

/** Score of each unit at each cut-off, shared by both horizons (the features do not depend on it). */
type ScoreCache = Map<string, { score: number } | null>;

const samplesAt = (
  index: SignalIndex,
  input: RiskInput,
  t: string,
  horizon: Horizon,
  cache: ScoreCache,
): Sample[] =>
  [...index.byUnit.keys()].flatMap((unit) => {
    const key = `${unit}|${t}`;
    let entry = cache.get(key);
    if (entry === undefined) {
      if (recentSignals(index, unit, t) > 0) {
        const factors = featuresAt(index, unit, t, input.irsa);
        assertNoLeakage(t, factors);
        entry = { score: scoreOf(factors) };
      } else entry = null;
      cache.set(key, entry);
    }
    return entry
      ? [{ score: entry.score, escalated: escalatedWithin(index, unit, t, horizon) }]
      : [];
  });

/** Time-split back-test and Platt calibration for one horizon (docs/adr/0031 §3). */
const calibrate = (
  index: SignalIndex,
  input: RiskInput,
  horizon: Horizon,
  cache: ScoreCache,
): Calibration => {
  const cutoffs = cutoffsFor(index, input.today, horizon);
  const nTrain = Math.floor(cutoffs.length * 0.7);
  const train = cutoffs.slice(0, nTrain).flatMap((t) => samplesAt(index, input, t, horizon, cache));
  const test = cutoffs.slice(nTrain).flatMap((t) => samplesAt(index, input, t, horizon, cache));
  const events = (samples: readonly Sample[]) => samples.filter((s) => s.escalated).length;
  const base = {
    horizon,
    cutoffs: cutoffs.length,
    from: cutoffs[0] ?? null,
    to: cutoffs.at(-1) ?? null,
    train: { samples: train.length, events: events(train) },
    test: { samples: test.length, events: events(test) },
  };
  if (
    events(train) < MIN_TRAIN_EVENTS ||
    train.length < MIN_TRAIN_SAMPLES ||
    test.length < MIN_TEST_SAMPLES
  )
    return {
      platt: null,
      backtest: {
        ...base,
        calibrated: false,
        reason: `Historial insuficiente para calibrar: ${train.length + test.length} muestras y ${events(train) + events(test)} escalamientos en ${cutoffs.length} cortes (se necesitan al menos ${MIN_TRAIN_SAMPLES + MIN_TEST_SAMPLES} muestras y ${MIN_TRAIN_EVENTS} escalamientos para entrenar).`,
        brier: null,
        brierReference: null,
        skill: null,
        bins: reliabilityBins([]),
      },
    };
  const platt = fitPlatt(train);
  const rate = events(train) / train.length;
  const pairs: BacktestPair[] = test.map((s) => ({
    p: probability(platt, s.score),
    y: s.escalated,
  }));
  const model = brier(pairs);
  const reference = brier(test.map((s) => ({ p: rate, y: s.escalated })));
  return {
    platt,
    backtest: {
      ...base,
      calibrated: true,
      reason: null,
      brier: round3(model),
      brierReference: round3(reference),
      skill: model !== null && reference ? round3(1 - model / reference) : null,
      bins: reliabilityBins(pairs),
    },
  };
};

const confidenceOf = (calibration: Calibration, signals: number): [Confidence, string] => {
  const { backtest } = calibration;
  if (!calibration.platt)
    return ['baja', 'Historial insuficiente para calibrar; el detalle está en el back-test.'];
  if (signals < 2) return ['baja', 'Una sola señal registrada en los últimos 180 días.'];
  const skill = backtest.skill ?? 0;
  if (skill <= 0) return ['baja', 'En el back-test el modelo no supera la tasa base del proyecto.'];
  return backtest.train.events >= 20
    ? [
        'alta',
        `Supera la tasa base en el back-test (${backtest.train.events} escalamientos de entrenamiento).`,
      ]
    : [
        'media',
        `Supera la tasa base en el back-test, con pocos escalamientos (${backtest.train.events}).`,
      ];
};

export type HorizonPrediction = {
  /** Rounded to 5 points; null when the history cannot calibrate it. */
  readonly probability: number | null;
  readonly band: Band;
};

export type Prediction = {
  readonly key: string;
  readonly kind: 'locality' | 'actor';
  readonly name: string;
  readonly score: number;
  readonly signals: number;
  readonly horizons: Readonly<Record<`${Horizon}`, HorizonPrediction>>;
  /** Of the 90-day horizon, the longer and better-sampled one. */
  readonly confidence: Confidence;
  readonly confidenceReason: string;
  /** Top contributing factors, highest first. */
  readonly factors: readonly Factor[];
};

export type ConflictRiskReport = {
  readonly generatedOn: string;
  readonly status: 'ok' | 'sin datos suficientes';
  readonly method: string;
  readonly backtest: Readonly<Record<`${Horizon}`, Backtest>>;
  readonly localities: readonly Prediction[];
  readonly actors: readonly Prediction[];
  readonly limitations: readonly string[];
};

const horizonPrediction = (calibration: Calibration, score: number): HorizonPrediction => {
  if (!calibration.platt) return { probability: null, band: signalBand(score) };
  const p = roundProbability(probability(calibration.platt, score));
  return { probability: p, band: probabilityBand(p) };
};

/** Localities and actors ranked by their escalation risk in 30 and 90 days (docs/adr/0031). */
export const conflictRisk = (input: RiskInput): ConflictRiskReport => {
  const index = indexSignals(input);
  const cache: ScoreCache = new Map();
  const calibrations = {
    '30': calibrate(index, input, 30, cache),
    '90': calibrate(index, input, 90, cache),
  } as const;
  const predictions = [...index.byUnit.keys()]
    .map((unit): Prediction | null => {
      const signals = recentSignals(index, unit, input.today);
      if (!signals) return null;
      const factors = featuresAt(index, unit, input.today, input.irsa);
      const score = scoreOf(factors);
      const [confidence, confidenceReason] = confidenceOf(calibrations['90'], signals);
      return {
        key: unit,
        kind: unit.startsWith('L:') ? 'locality' : 'actor',
        name: index.names.get(unit) ?? unit.slice(2),
        score,
        signals,
        horizons: {
          '30': horizonPrediction(calibrations['30'], score),
          '90': horizonPrediction(calibrations['90'], score),
        },
        confidence,
        confidenceReason,
        factors: factors.slice(0, 4),
      };
    })
    .filter((p): p is Prediction => p !== null)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'es'));
  return {
    generatedOn: input.today,
    status: predictions.length ? 'ok' : 'sin datos suficientes',
    method: METHOD,
    backtest: { '30': calibrations['30'].backtest, '90': calibrations['90'].backtest },
    localities: predictions.filter((p) => p.kind === 'locality').slice(0, MAX_UNITS),
    actors: predictions.filter((p) => p.kind === 'actor').slice(0, MAX_UNITS),
    limitations: LIMITATIONS,
  };
};
