/** SIPGES project settings (docs/adr/0020 §1). Pure: no I/O. */

export const LEVELS = ['Verde', 'Amarillo', 'Naranja', 'Rojo'] as const;
export type Level = (typeof LEVELS)[number];

/** Life-cycle phases of a project (docs/adr/0021 §4). */
export const PHASES = ['exploracion', 'construccion', 'operacion', 'cierre'] as const;
export type Phase = (typeof PHASES)[number];
export const PHASE_LABELS: Readonly<Record<Phase, string>> = {
  exploracion: 'Exploración',
  construccion: 'Construcción',
  operacion: 'Operación',
  cierre: 'Cierre',
};

/** IRSA dimensions, as the Indicators context names them. */
export const DIMENSION_KEYS = ['G', 'A', 'D', 'N', 'E', 'I'] as const;
export type DimensionKey = (typeof DIMENSION_KEYS)[number];
export type PhaseWeights = Readonly<Record<DimensionKey, number>>;

/**
 * Preliminary starting points, never applied on their own: an admin saves them or their own.
 * Exploration leans on actors and narratives, construction on demands and the environment,
 * operation on the environment and commitments, closure on commitments and legacy.
 */
export const PHASE_WEIGHT_SUGGESTIONS: Readonly<Record<Phase, PhaseWeights>> = {
  exploracion: { G: 0.2, A: 0.25, D: 0.15, N: 0.2, E: 0.1, I: 0.1 },
  construccion: { G: 0.15, A: 0.15, D: 0.25, N: 0.15, E: 0.2, I: 0.1 },
  operacion: { G: 0.15, A: 0.15, D: 0.2, N: 0.15, E: 0.25, I: 0.1 },
  cierre: { G: 0.15, A: 0.1, D: 0.25, N: 0.1, E: 0.25, I: 0.15 },
};

export type ProjectSettings = {
  /** Preliminary meanings, to be reviewed with the client's methodology owner. */
  readonly levelMeanings: Readonly<Record<Level, string>>;
  /** Records older than this many days do not form situations. */
  readonly windowDays: number;
  /** A record's weight halves every this many days. */
  readonly halfLifeDays: number;
  /** Score at which each colour starts; below Amarillo is Verde. */
  readonly thresholds: Readonly<Record<Exclude<Level, 'Verde'>, number>>;
  /** Project wording of the recommendation catalogue, by condition id; missing ids use defaults. */
  readonly recommendations: Readonly<Record<string, string>>;
  /** Current life-cycle phase; null until an admin sets it. */
  readonly phase: Phase | null;
  /** IRSA weights saved for each phase; a phase without weights uses the general ones. */
  readonly phaseWeights: Readonly<Partial<Record<Phase, PhaseWeights>>>;
  /**
   * «Envío a IA externa» (docs/adr/0030): whether data of this project may go, pseudonymised,
   * to an external model or client. Off until an admin turns it on.
   */
  readonly externalAi: { readonly enabled: boolean };
  readonly updatedBy: string;
  readonly updatedAt: Date | null;
};

type Editable =
  | 'levelMeanings'
  | 'windowDays'
  | 'halfLifeDays'
  | 'thresholds'
  | 'recommendations'
  | 'phase'
  | 'externalAi';
/**
 * Fields left undefined keep their current value. Phase weights merge by phase; null removes
 * a phase's weights so it falls back to the general ones.
 */
export type ProjectSettingsPatch = { readonly [K in Editable]?: ProjectSettings[K] | undefined } & {
  readonly phaseWeights?: Readonly<Partial<Record<Phase, PhaseWeights | null>>> | undefined;
};

export const DEFAULT_SETTINGS: ProjectSettings = {
  levelMeanings: {
    Verde: 'Situación estable / riesgo bajo',
    Amarillo: 'Requiere atención y seguimiento',
    Naranja: 'Requiere intervención preventiva',
    Rojo: 'Situación crítica / atención inmediata',
  },
  windowDays: 90,
  halfLifeDays: 14,
  thresholds: { Amarillo: 2, Naranja: 4, Rojo: 7 },
  recommendations: {},
  phase: null,
  phaseWeights: {},
  externalAi: { enabled: false },
  updatedBy: '',
  updatedAt: null,
};

/**
 * Stored settings over the defaults, so a later field never reads as missing. Fields are picked
 * one by one: the `version4` key that earlier releases stored is not part of the settings and is
 * neither read nor carried into a later save.
 */
export const withDefaults = (stored: Partial<ProjectSettings> | null): ProjectSettings => ({
  windowDays: stored?.windowDays ?? DEFAULT_SETTINGS.windowDays,
  halfLifeDays: stored?.halfLifeDays ?? DEFAULT_SETTINGS.halfLifeDays,
  updatedBy: stored?.updatedBy ?? DEFAULT_SETTINGS.updatedBy,
  updatedAt: stored?.updatedAt ?? DEFAULT_SETTINGS.updatedAt,
  levelMeanings: { ...DEFAULT_SETTINGS.levelMeanings, ...stored?.levelMeanings },
  thresholds: { ...DEFAULT_SETTINGS.thresholds, ...stored?.thresholds },
  recommendations: { ...stored?.recommendations },
  phase: stored?.phase ?? null,
  phaseWeights: { ...stored?.phaseWeights },
  externalAi: { enabled: stored?.externalAi?.enabled === true },
});

/** The weights IRSA should use instead of the general ones, or null to leave IRSA as is. */
export const activePhaseWeights = (
  settings: Pick<ProjectSettings, 'phase' | 'phaseWeights'>,
): { phase: Phase; label: string; weights: PhaseWeights } | null => {
  if (!settings.phase) return null;
  const weights = settings.phaseWeights[settings.phase];
  return weights ? { phase: settings.phase, label: PHASE_LABELS[settings.phase], weights } : null;
};

export const applySettingsPatch = (
  current: ProjectSettings,
  patch: ProjectSettingsPatch,
  actor: string,
  at: Date,
): ProjectSettings => {
  const { phaseWeights, ...rest } = patch;
  const changes = (phaseWeights ?? {}) as Partial<Record<Phase, PhaseWeights | null>>;
  const merged = Object.fromEntries(
    PHASES.flatMap((phase) => {
      const weights = phase in changes ? changes[phase] : current.phaseWeights[phase];
      return weights ? [[phase, weights]] : [];
    }),
  ) as Partial<Record<Phase, PhaseWeights>>;
  return {
    ...current,
    ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)),
    phaseWeights: merged,
    updatedBy: actor,
    updatedAt: at,
  };
};

/** "Naranja – Requiere intervención preventiva". */
export const levelText = (settings: Pick<ProjectSettings, 'levelMeanings'>, level: Level) =>
  `${level} – ${settings.levelMeanings[level]}`;

/** Which fields a change touched, for the audit row. */
export const changedFields = (before: ProjectSettings, after: ProjectSettings) =>
  (
    [
      'levelMeanings',
      'windowDays',
      'halfLifeDays',
      'thresholds',
      'recommendations',
      'phase',
      'phaseWeights',
      'externalAi',
    ] as const
  ).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
