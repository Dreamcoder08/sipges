import { createHash } from 'node:crypto';
import { type Result, err, ok } from '@mascli/kernel';
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
  isAlertState,
  isPublicHttpUrl,
} from '../domain/index.ts';
import type { AlertStore, Clock, EmbeddingProvider, NarrativeReader, RandomHex } from './ports.ts';

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
  { readonly kind: 'status' } | { readonly kind: 'note_too_long' } | { readonly kind: 'missing' };

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

export const createIntelligenceService = (deps: {
  narratives: NarrativeReader;
  embeddings: EmbeddingProvider;
  alerts: AlertStore;
  clock: Clock;
  randomHex: RandomHex;
}) => {
  const { narratives, embeddings, alerts, clock, randomHex } = deps;
  // Reference concepts never change for a model, so their vectors are computed once.
  const conceptVectors = new Map<string, Promise<number[]>>();
  const conceptVector = (description: string) => {
    let vector = conceptVectors.get(description);
    if (!vector) {
      vector = embeddings.embed(description);
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
      verification_status: 'Pendiente de corroboración humana',
      source_retrieved: false,
    };
    if (input.mode === 'rules') return ok(report);
    try {
      const entries = Object.entries(SEMANTIC_CONCEPTS);
      // The text and any uncached concept are embedded concurrently: one model round trip.
      const [content, vectors] = await Promise.all([
        embeddings.embed(input.text.trim()),
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
        'Análisis híbrido: reglas y similitud semántica local. Requiere corroboración humana.';
    } catch {
      if (input.mode === 'semantic') return err({ kind: 'unavailable' });
      report.semantic.note =
        'Ollama local no disponible; se aplicaron únicamente reglas. El análisis semántico NO se ejecutó.';
    }
    return ok(report);
  };

  return {
    classify: classifyRecord,
    analyzeText: analyze,
    semanticAnalyze: semantic,

    async createAlert(
      scope: Scope,
      input: SemanticInput & { sourceType: string; analystNote: string },
    ): Promise<Result<{ alert: TerritorialAlert; analysis: SemanticReport }, AlertCreateError>> {
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
      return ok({ alert, analysis: a });
    },

    listAlerts(scope: Scope, limit: number) {
      return alerts.list(formatScope(scope), {
        projectId: scope.projectId,
        limit: Math.max(1, Math.min(limit, MAX_ALERT_LIST)),
      });
    },

    async decideAlert(
      scope: Scope,
      input: { id: string; status: string; note: string },
    ): Promise<Result<AlertState, AlertDecisionError>> {
      if (!isAlertState(input.status)) return err({ kind: 'status' });
      if (Array.from(input.note).length > MAX_NOTE_LENGTH) return err({ kind: 'note_too_long' });
      if (input.id.length > 64) return err({ kind: 'missing' });
      const found = await alerts.decide(formatScope(scope), {
        id: input.id,
        status: input.status,
        note: input.note,
        at: clock.now(),
      });
      return found ? ok(input.status) : err({ kind: 'missing' });
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
