import { type Scope, formatScope } from '../../tenancy/application/index.ts';
import {
  PHASE_LABELS,
  type ProjectSettings,
  type ProjectSettingsPatch,
  activePhaseWeights,
  applySettingsPatch,
  changedFields,
  withDefaults,
} from '../domain/settings.ts';
import { MODULE_SPECS, type SourceRecord } from '../domain/signals.ts';
import {
  DEFAULT_RECOMMENDATIONS,
  RECOMMENDATION_CONDITIONS,
  RECOMMENDATION_IDS,
  LESSONS_MODULE,
  attachLessons,
  findSituations,
} from '../domain/situations.ts';

export type { ProjectSettings, ProjectSettingsPatch } from '../domain/settings.ts';
export {
  DIMENSION_KEYS,
  PHASES,
  PHASE_LABELS,
  PHASE_WEIGHT_SUGGESTIONS,
  type Phase,
  type PhaseWeights,
} from '../domain/settings.ts';
export type { Situation, SituationsReport } from '../domain/situations.ts';

/** Read-only: the tenant's records of the given modules (row-level security applies). */
export type SituationRecordReader = {
  read(tenantId: string, modules: readonly string[]): Promise<SourceRecord[]>;
};

export type ProjectSettingsStore = {
  load(tenantId: string): Promise<Partial<ProjectSettings> | null>;
  /** Saves and appends the audit row in one tenant transaction. */
  save(tenantId: string, settings: ProjectSettings, auditDetail: string): Promise<void>;
};

export type Clock = { now(): Date };

/** Calendar day in Peru, where the projects are: a record dated today is never "in the future". */
const LIMA_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' });

const LIMITATIONS = [
  'Agrupación por reglas sobre registros documentados: orienta la revisión, no predice conflictos.',
  'El territorio sale solo de los campos registrados; los registros sin fecha no forman situaciones.',
  'Las recomendaciones orientan; la decisión y la alerta las confirma siempre una persona.',
  'No modifica el IRSA. Umbrales y significados son preliminares y configurables.',
];

/** SIPGES use cases (docs/adr/0020). */
export const createSituationsService = (deps: {
  settings: ProjectSettingsStore;
  records: SituationRecordReader;
  clock: Clock;
}) => {
  const { settings, records, clock } = deps;
  const load = async (scope: Scope) => withDefaults(await settings.load(formatScope(scope)));
  return {
    settings: load,
    /** Phase weights IRSA uses instead of the general ones, once the current phase has some saved. */
    phaseWeights: async (tenantId: string) =>
      activePhaseWeights(withDefaults(await settings.load(tenantId))),
    /** Whether the project allows data to go to an external model or client (default off). */
    externalAiEnabled: async (tenantId: string) =>
      withDefaults(await settings.load(tenantId)).externalAi.enabled,
    /** Every condition of the catalogue with the project's wording or the default. */
    recommendationCatalogue: (current: ProjectSettings) =>
      RECOMMENDATION_IDS.map((id) => ({
        id,
        condition: RECOMMENDATION_CONDITIONS[id],
        text: current.recommendations[id] ?? DEFAULT_RECOMMENDATIONS[id],
        custom: current.recommendations[id] !== undefined,
      })),
    async situations(scope: Scope) {
      const current = await load(scope);
      const now = clock.now();
      const today = LIMA_DAY.format(now);
      const read = await records.read(formatScope(scope), [
        ...Object.keys(MODULE_SPECS),
        LESSONS_MODULE,
      ]);
      const report = findSituations(
        read.filter((r) => r.module !== LESSONS_MODULE),
        current,
        today,
        { ...DEFAULT_RECOMMENDATIONS, ...current.recommendations },
      );
      return {
        ...report,
        situations: attachLessons(
          report.situations,
          read.filter((r) => r.module === LESSONS_MODULE),
        ),
        generatedAt: now,
        today,
        windowDays: current.windowDays,
        method:
          'Registros con fecha que comparten tema, actor o territorio registrado en la ventana del proyecto; cada registro pesa la mitad cada vida media y más si su prioridad es alta.',
        limitations: LIMITATIONS,
      };
    },
    async updateSettings(scope: Scope, patch: ProjectSettingsPatch, actor: string) {
      const before = await load(scope);
      const after = applySettingsPatch(before, patch, actor, clock.now());
      const fields = changedFields(before, after);
      if (fields.length) {
        const phase = fields.includes('phase')
          ? `ase ${after.phase ? PHASE_LABELS[after.phase] : 'sin definir'}; `
          : '';
        const detail = `${phase && `F${phase}`}Campos: ${fields.join(', ')}`;
        await settings.save(formatScope(scope), after, detail);
        return after;
      }
      return before;
    },
  };
};

export type SituationsService = ReturnType<typeof createSituationsService>;
