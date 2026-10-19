/** MASCLI 4.0 project settings (docs/adr/0020 §1). Pure: no I/O. */

export const LEVELS = ['Verde', 'Amarillo', 'Naranja', 'Rojo'] as const;
export type Level = (typeof LEVELS)[number];

export type ProjectSettings = {
  /** Off by default: the project keeps the MASCLI 3.0 screens. */
  readonly version4: boolean;
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
  readonly updatedBy: string;
  readonly updatedAt: Date | null;
};

type Editable =
  'version4' | 'levelMeanings' | 'windowDays' | 'halfLifeDays' | 'thresholds' | 'recommendations';
/** Fields left undefined keep their current value. */
export type ProjectSettingsPatch = { readonly [K in Editable]?: ProjectSettings[K] | undefined };

export const DEFAULT_SETTINGS: ProjectSettings = {
  version4: false,
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
  updatedBy: '',
  updatedAt: null,
};

/** Stored settings over the defaults, so a later field never reads as missing. */
export const withDefaults = (stored: Partial<ProjectSettings> | null): ProjectSettings => ({
  ...DEFAULT_SETTINGS,
  ...stored,
  levelMeanings: { ...DEFAULT_SETTINGS.levelMeanings, ...stored?.levelMeanings },
  thresholds: { ...DEFAULT_SETTINGS.thresholds, ...stored?.thresholds },
  recommendations: { ...stored?.recommendations },
});

export const applySettingsPatch = (
  current: ProjectSettings,
  patch: ProjectSettingsPatch,
  actor: string,
  at: Date,
): ProjectSettings => ({
  ...current,
  ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
  updatedBy: actor,
  updatedAt: at,
});

/** "Naranja – Requiere intervención preventiva". */
export const levelText = (settings: Pick<ProjectSettings, 'levelMeanings'>, level: Level) =>
  `${level} – ${settings.levelMeanings[level]}`;

/** Which fields a change touched, for the audit row. */
export const changedFields = (before: ProjectSettings, after: ProjectSettings) =>
  (
    [
      'version4',
      'levelMeanings',
      'windowDays',
      'halfLifeDays',
      'thresholds',
      'recommendations',
    ] as const
  ).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
