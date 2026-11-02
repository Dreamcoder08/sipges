import { createHash } from 'node:crypto';
import { type Result, err, ok } from '@sipges/kernel';
import {
  type EgressGuard,
  EXTERNAL_AI_DISABLED,
  exemptPayload,
} from '../../privacy/application/index.ts';
import { type Scope, formatScope } from '../../tenancy/application/index.ts';
import {
  ANALYSIS_MODES,
  type AlertState,
  MAX_ALERT_LIST,
  MAX_NOTE_LENGTH,
  SEMANTIC_CONCEPTS,
  SEMANTIC_THRESHOLD,
  SOURCE_TYPES,
  type TerritorialAlert,
  type TextAnalysisError,
  type TextReport,
  alertSummary,
  analyzeText,
  classifyRecord,
  cosine,
  fourEyes,
  isAlertState,
  isPublicHttpUrl,
} from '../domain/index.ts';
import type {
  AlertStore,
  Clock,
  EmbeddingProvider,
  ExternalAiSwitch,
  NarrativeReader,
  RandomHex,
} from './ports.ts';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

const codePointSlice = (text: string, count: number) => Array.from(text).slice(0, count).join('');

export type TextInput = { readonly text: string; readonly sourceUrl: string };
export type SemanticInput = TextInput & { readonly mode: string };

export type SemanticError =
  | TextAnalysisError
  | { readonly kind: 'mode' }
  | { readonly kind: 'url' }
  | { readonly kind: 'unavailable' };

export type AlertCreateError = SemanticError | { readonly kind: 'source_type' };

export type AlertDecisionError =
  | { readonly kind: 'status' }
  | { readonly kind: 'note_too_long' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'same_person' };

type SemanticMatch = { theme: string; similarity: number; reference: string };

export type SemanticReport = Omit<TextReport, 'version'> & {
  version: '2.5';
  semantic: {
    active: boolean;
    method: string;
    model?: string;
    matches: SemanticMatch[];
    note: string;
  };
  verification_status: string;
  source_retrieved: false;
};

/** Why semantic features are off: no reachable model, or external AI switched off. */
export type EmbedderUnavailableReason = 'unreachable' | 'external_ai_disabled';

export type EmbedderStatus = {
  readonly available: boolean;
  readonly reason: EmbedderUnavailableReason | null;
  readonly model: string;
  readonly egress: EmbeddingProvider['egress'];
};

/** How long one probe answers for every caller; short so a recovered model shows up soon. */
const PROBE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 3_000;
/** Text written in the code: probing never sends tenant data (ADR 0030 `constant`). */
const PROBE_TEXT = 'sipges';

export const createIntelligenceService = (deps: {
  narratives: NarrativeReader;
  embeddings: EmbeddingProvider;
  /** Clears the text sent to an embeddings service that is not on this machine (ADR 0030). */
  egress: EgressGuard;
  /**
   * The project's external AI switch; an external embedder is not even probed while off.
   * Absent means off: fail closed.
   */
  externalAi?: ExternalAiSwitch;
  alerts: AlertStore;
  clock: Clock;
  randomHex: RandomHex;
}) => {
  const { narratives, embeddings, alerts, clock, randomHex } = deps;

  let probe: { at: number; reachable: Promise<boolean> } | undefined;
  const reachable = () => {
    const now = clock.now().getTime();
    if (!probe || now - probe.at >= PROBE_TTL_MS) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
      });
      const attempt = embeddings.embed(exemptPayload(PROBE_TEXT, 'constant')).then(
        () => true,
        () => false,
      );
      probe = {
        at: now,
        reachable: Promise.race([attempt, timeout]).finally(() => clearTimeout(timer)),
      };
    }
    return probe.reachable;
  };

  const embedderStatus = async (scope: Scope): Promise<EmbedderStatus> => {
    const base = { model: embeddings.model, egress: embeddings.egress };
    if (embeddings.egress !== 'local' && !(await deps.externalAi?.enabled(formatScope(scope))))
      return { ...base, available: false, reason: 'external_ai_disabled' };
    return (await reachable())
      ? { ...base, available: true, reason: null }
      : { ...base, available: false, reason: 'unreachable' };
  };
  // Reference concepts never change for a model, so their vectors are computed once.
  const conceptVectors = new Map<string, Promise<number[]>>();
  const conceptVector = (description: string) => {
    let vector = conceptVectors.get(description);
    if (!vector) {
      // A reference description is written in the code: no tenant data is in it.
      vector = embeddings.embed(exemptPayload(description, 'constant'));
      vector.catch(() => conceptVectors.delete(description));
      conceptVectors.set(description, vector);
    }
    return vector;
  };

  const analyze = async (
    scope: Scope,
    input: TextInput,
  ): Promise<Result<TextReport, TextAnalysisError>> => {
    const result = analyzeText(
      { text: input.text, projectId: scope.projectId, sourceUrl: input.sourceUrl },
      await narratives.read(scope),
      sha256,
    );
    return result.ok ? ok(result.value) : err(result.error);
  };

  const semantic = async (
    scope: Scope,
    input: SemanticInput,
  ): Promise<Result<SemanticReport, SemanticError>> => {
    if (!(ANALYSIS_MODES as readonly string[]).includes(input.mode)) return err({ kind: 'mode' });
    if (input.sourceUrl && !isPublicHttpUrl(input.sourceUrl)) return err({ kind: 'url' });
    const base = await analyze(scope, input);
    if (!base.ok) return base;
    const report: SemanticReport = {
      ...base.value,
      version: '2.5',
      semantic: {
        active: false,
        method: 'Reglas verificables; sin modelo semántico',
        matches: [],
        note: 'Análisis de temas por reglas. No se ha interpretado semánticamente el texto.',
      },
      verification_status: 'Pendiente de corroboración',
      source_retrieved: false,
    };
    if (input.mode === 'rules') return ok(report);
    try {
      const entries = Object.entries(SEMANTIC_CONCEPTS);
      const trimmed = input.text.trim();
      let cleared;
      if (embeddings.egress === 'local') cleared = exemptPayload(trimmed, 'loopback');
      else {
        const opened = await deps.egress.open({
          tenantId: formatScope(scope),
          channel: 'embeddings',
          purpose: 'semantic-analyze',
        });
        if (!opened.ok) throw new Error(EXTERNAL_AI_DISABLED);
        cleared = await opened.session.release(opened.session.text(trimmed));
      }
      // The text and any uncached concept are embedded concurrently: one model round trip.
      const [content, vectors] = await Promise.all([
        embeddings.embed(cleared),
        Promise.all(entries.map(([, description]) => conceptVector(description))),
      ]);
      const scored = entries
        .map(([theme, reference], i) => ({
          theme,
          raw: cosine(content, vectors[i] ?? []),
          reference,
        }))
        .filter((x) => x.raw >= SEMANTIC_THRESHOLD)
        .map(({ theme, raw, reference }) => ({
          theme,
          similarity: Math.round(raw * 1000) / 1000,
          reference,
        }))
        .sort((a, b) => b.similarity - a.similarity);
      report.semantic = {
        active: true,
        method: 'Similitud coseno de embeddings del modelo local Ollama',
        model: embeddings.model,
        matches: scored.slice(0, 5),
        note: 'Los valores son similitudes relativas, no probabilidades de conflicto ni pruebas de veracidad.',
      };
      report.method =
        'Análisis híbrido: reglas y similitud semántica local. Requiere corroboración.';
    } catch {
      if (input.mode === 'semantic') return err({ kind: 'unavailable' });
      report.semantic.note =
        'Ollama local no disponible; se aplicaron únicamente reglas. El análisis semántico NO se ejecutó.';
    }
    return ok(report);
  };

  const createAlert = async (
    scope: Scope,
    input: SemanticInput & {
      sourceType: string;
      analystNote: string;
      territory?: string | null;
      sourceRecord?: TerritorialAlert['sourceRecord'];
    },
  ): Promise<
    Result<
      { alert: TerritorialAlert; analysis: SemanticReport; outcome: 'created' | 'duplicate' },
      AlertCreateError
    >
  > => {
    if (!(SOURCE_TYPES as readonly string[]).includes(input.sourceType))
      return err({ kind: 'source_type' });
    const analysis = await semantic(scope, input);
    if (!analysis.ok) return analysis;
    const a = analysis.value;
    const alert = await alerts.create(formatScope(scope), {
      id: `DIG-${randomHex(12).toUpperCase()}`,
      projectId: scope.projectId,
      createdAt: clock.now(),
      sourceUrl: input.sourceUrl,
      sourceType: input.sourceType,
      territory: input.territory?.trim() || null,
      sourceRecord: input.sourceRecord ?? null,
      excerpt: codePointSlice(input.text.trim(), 500),
      sha256: a.evidence.sha256,
      level: a.orientation.level,
      score: a.orientation.score,
      method: a.method,
      themes: a.topics,
      signals: a.signals,
      suggestions: a.suggested_actions,
      semanticActive: a.semantic.active,
      analystNote: codePointSlice(input.analystNote, MAX_NOTE_LENGTH),
    });
    return ok({ alert, analysis: a, outcome: alert.duplicate ? 'duplicate' : 'created' });
  };

  return {
    classify: classifyRecord,
    analyzeText: analyze,
    semanticAnalyze: semantic,
    embedderStatus,

    createAlert,

    async evaluateNarrative(
      scope: Scope,
      input: {
        id: string;
        payload: Readonly<Record<string, unknown>>;
        marking: string;
        minimumLevel?: 'Media' | 'Alta';
      },
    ): Promise<{ outcome: 'created' | 'duplicate' | 'ineligible'; alertId?: string }> {
      // Fail closed: restricted/unknown markings must never enter the broader digital inbox.
      if (!['publico', 'interno'].includes(input.marking) || !input.id || input.id.length > 200)
        return { outcome: 'ineligible' };
      const sourceType = input.payload.Tipo_Fuente ?? 'Publicación digital';
      if (
        typeof sourceType !== 'string' ||
        !(SOURCE_TYPES as readonly string[]).includes(sourceType)
      )
        return { outcome: 'ineligible' };
      const text = typeof input.payload.Descripcion === 'string' ? input.payload.Descripcion : '';
      const sourceUrl =
        typeof input.payload.URL_Publicacion === 'string'
          ? input.payload.URL_Publicacion.trim()
          : '';
      const territory =
        typeof input.payload.Territorio === 'string' ? input.payload.Territorio.trim() : null;
      if (territory && territory.length > 500) return { outcome: 'ineligible' };
      const analysis = await semantic(scope, { text, sourceUrl, mode: 'rules' });
      if (!analysis.ok) return { outcome: 'ineligible' };
      const level = analysis.value.orientation.level;
      if (level !== 'Alta' && (input.minimumLevel === 'Alta' || level !== 'Media'))
        return { outcome: 'ineligible' };
      const result = await createAlert(scope, {
        text,
        sourceUrl,
        mode: 'rules',
        sourceType,
        analystNote: '',
        territory,
        sourceRecord: { module: 'Narrativas', id: input.id },
      });
      return result.ok
        ? { outcome: result.value.outcome, alertId: result.value.alert.id }
        : { outcome: 'ineligible' };
    },

    async getAlert(scope: Scope, id: string) {
      if (!id || id.length > 80) return null;
      const alert = await alerts.get(formatScope(scope), id);
      return alert && alert.projectId === scope.projectId ? alert : null;
    },

    listAlerts(scope: Scope, limit: number) {
      return alerts.list(formatScope(scope), {
        projectId: scope.projectId,
        limit: Math.max(1, Math.min(limit, MAX_ALERT_LIST)),
      });
    },

    /** The resulting status, and whether a second person still has to validate. */
    async decideAlert(
      scope: Scope,
      input: { id: string; status: string; note: string },
      actor: string,
    ): Promise<Result<{ status: AlertState; pendingSecond: boolean }, AlertDecisionError>> {
      if (!isAlertState(input.status)) return err({ kind: 'status' });
      if (Array.from(input.note).length > MAX_NOTE_LENGTH) return err({ kind: 'note_too_long' });
      if (input.id.length > 64) return err({ kind: 'missing' });
      const current = await alerts.get(formatScope(scope), input.id);
      if (!current || current.projectId !== scope.projectId) return err({ kind: 'missing' });
      const outcome = fourEyes({
        level: current.level,
        current: current.status,
        next: input.status,
        firstValidator: current.firstValidator ?? null,
        actor,
      });
      if (outcome === 'same_person') return err({ kind: 'same_person' });
      if (outcome === 'first') {
        const recorded = await alerts.recordFirstValidation(formatScope(scope), {
          id: input.id,
          actor,
          note: input.note,
          at: clock.now(),
        });
        return recorded
          ? ok({ status: current.status, pendingSecond: true })
          : err({ kind: 'missing' });
      }
      const found = await alerts.decide(formatScope(scope), {
        id: input.id,
        status: input.status,
        note: input.note,
        at: clock.now(),
      });
      return found ? ok({ status: input.status, pendingSecond: false }) : err({ kind: 'missing' });
    },

    async summary(scope: Scope) {
      const items = await alerts.list(formatScope(scope), {
        projectId: scope.projectId,
        limit: MAX_ALERT_LIST,
      });
      return alertSummary(scope.projectId, items);
    },

    /** Status of one alert of the scope, for the prevention context (null when missing). */
    async alertStatus(scope: Scope, id: string) {
      if (id.length > 80) return null;
      const alert = await alerts.get(formatScope(scope), id);
      return alert && alert.projectId === scope.projectId ? alert.status : null;
    },

    /** Every alert of the scope, newest first, for management reporting. */
    allAlerts(scope: Scope) {
      return alerts.list(formatScope(scope), { projectId: scope.projectId, limit: 100_000 });
    },
  };
};

export type IntelligenceService = ReturnType<typeof createIntelligenceService>;
