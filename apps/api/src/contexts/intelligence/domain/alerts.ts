/** Territorial alert inbox (app.py:2045-2125, RC 2.6). Kept apart from IRSA by design. */

export const ALERT_STATES = [
  'Pendiente de verificación',
  'Corroborado',
  'Descartado',
  'En seguimiento',
] as const;
export type AlertState = (typeof ALERT_STATES)[number];

export const isAlertState = (value: string): value is AlertState =>
  (ALERT_STATES as readonly string[]).includes(value);

export const SOURCE_TYPES = ['Publicación digital', 'Documento', 'Reporte de campo'] as const;

export const ANALYSIS_MODES = ['automatic', 'semantic', 'rules'] as const;
export type AnalysisMode = (typeof ANALYSIS_MODES)[number];

/** Alerts a preventive plan may follow: verified by a person first. */
export const ACTIONABLE_STATES: readonly AlertState[] = ['Corroborado', 'En seguimiento'];

export const PRIORITY_LEVELS = ['Alta', 'Media', 'Baja'] as const;

export const MAX_NOTE_LENGTH = 2000;
export const MAX_ALERT_LIST = 200;

export type TerritorialAlert = {
  readonly id: string;
  readonly projectId: string;
  readonly createdAt: Date;
  readonly sourceUrl: string;
  readonly sourceType: string;
  readonly excerpt: string;
  readonly sha256: string;
  readonly level: string;
  readonly score: number;
  readonly method: string;
  readonly themes: readonly { tema: string }[];
  readonly signals: readonly unknown[];
  readonly suggestions: readonly string[];
  readonly semanticActive: boolean;
  readonly status: AlertState;
  readonly analystNote: string;
  readonly reviewerNote: string | null;
  readonly reviewedAt: Date | null;
};

/** `Counter(...).most_common(n)`: count descending, ties in first-seen order. */
export const mostCommon = (values: readonly string[], limit: number) => {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, limit);
};

export const alertSummary = (projectId: string, items: readonly TerritorialAlert[]) => ({
  version: '2.6',
  project_id: projectId,
  total: items.length,
  by_status: Object.fromEntries(
    ALERT_STATES.map((s) => [s, items.filter((r) => r.status === s).length]),
  ),
  by_priority: Object.fromEntries(
    PRIORITY_LEVELS.map((l) => [l, items.filter((r) => r.level === l).length]),
  ),
  themes: mostCommon(
    items.flatMap((r) => r.themes.map((t) => t.tema)),
    12,
  ).map(([name, count]) => ({ name, count })),
  irsa_integration: 'Sin modificación automática del IRSA; requiere validación metodológica',
  caution: 'Registros manuales, sin monitoreo permanente ni corroboración automática.',
});
