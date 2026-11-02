import {
  isCompletedStatus,
  isTerminalStatus,
  isValidCalendarDate,
  recordDueDate,
  roundHalfEven,
} from '@sipges/kernel';

/** Per-project management center (app.py:2224-2270, RC 2.8). Descriptive counts only. */

export type AlertRow = {
  readonly id: string;
  readonly createdAt: string;
  readonly sourceUrl: string;
  readonly sourceType: string;
  readonly level: string;
  readonly score: number;
  readonly status: string;
  readonly reviewedAt: string | null;
};

export type ActionRow = {
  readonly id: string;
  readonly alertId: string;
  readonly title: string;
  readonly responsible: string;
  readonly dueDate: string;
  readonly status: string;
  readonly progress: number;
  readonly updatedAt: string;
};

export type Commitment = {
  readonly id: string;
  readonly responsible: string;
  readonly status: string;
  readonly due_date: string;
};

const counter = (values: readonly string[]) => {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return counts;
};

const truthy = (v: unknown) =>
  v !== undefined &&
  v !== null &&
  v !== false &&
  v !== 0 &&
  v !== '' &&
  !(Array.isArray(v) && v.length === 0) &&
  !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0);

const str = (v: unknown) =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : JSON.stringify(v);

/** `Compromisos` records of the tenant, which is the project (S13): `Proyecto_ID` is not re-checked. */
export const commitmentsOf = (
  records: readonly { id: string; payload: Readonly<Record<string, unknown>> }[],
): Commitment[] =>
  records.map(({ id, payload }) => {
    const pick = (...keys: string[]) => {
      const key = keys.find((k) => truthy(payload[k]));
      return key === undefined ? '' : str(payload[key]);
    };
    return {
      id,
      responsible: pick('Responsable'),
      status: pick('Estado'),
      due_date: recordDueDate(payload) ?? '',
    };
  });

const alertJson = (a: AlertRow) => ({
  id: a.id,
  created_at: a.createdAt,
  source_url: a.sourceUrl,
  source_type: a.sourceType,
  level: a.level,
  score: a.score,
  status: a.status,
  reviewed_at: a.reviewedAt,
});

const actionJson = (a: ActionRow) => ({
  id: a.id,
  alert_id: a.alertId,
  title: a.title,
  responsible: a.responsible,
  due_date: a.dueDate,
  status: a.status,
  progress: a.progress,
  updated_at: a.updatedAt,
});

/**
 * `alerts` newest first and `actions` by due date ascending, as app.py queried them.
 * app.py's "Sin autenticación empresarial" limitation no longer holds and is replaced.
 */
export const managementOverview = (input: {
  projectId: string;
  generatedAt: string;
  today: string;
  alerts: readonly AlertRow[];
  actions: readonly ActionRow[];
  commitments: readonly Commitment[];
}) => {
  const { alerts, actions, commitments, today } = input;
  const ongoing = actions.filter((r) => !isTerminalStatus(r.status));
  const late = ongoing.filter(
    (r) => isValidCalendarDate(r.dueDate) && isValidCalendarDate(today) && r.dueDate < today,
  );
  const pending = alerts.filter((r) => r.status === 'Pendiente de verificación');
  const high = alerts.filter((r) => r.level === 'Alta' && r.status !== 'Descartado');
  const critical = [...late]
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0))
    .slice(0, 20);
  const completed = actions.filter((x) => isCompletedStatus(x.status)).length;
  const byResponsible = [...counter(actions.map((x) => x.responsible))]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30);
  return {
    version: '2.8',
    project_id: input.projectId,
    generated_at: input.generatedAt,
    metrics: {
      digital_alerts: alerts.length,
      high_priority_alerts: high.length,
      pending_review: pending.length,
      total_actions: actions.length,
      active_actions: ongoing.length,
      overdue_actions: late.length,
      completed_actions: completed,
      completion_percent: actions.length ? roundHalfEven((100 * completed) / actions.length, 1) : 0,
      average_progress: actions.length
        ? roundHalfEven(actions.reduce((n, x) => n + x.progress, 0) / actions.length, 1)
        : 0,
      registered_commitments: commitments.length,
      overdue_commitments_explicit: commitments.filter((x) =>
        x.status.toLowerCase().includes('vencid'),
      ).length,
    },
    alerts_by_level: Object.fromEntries(counter(alerts.map((x) => x.level))),
    actions_by_status: Object.fromEntries(counter(actions.map((x) => x.status))),
    actions_by_responsible: byResponsible.map(([name, total]) => ({
      name,
      total,
      overdue: late.filter((x) => x.responsible === name).length,
    })),
    critical_actions: critical.map(actionJson),
    recent_alerts: alerts.slice(0, 15).map(alertJson),
    commitments: commitments.slice(0, 100),
    methodology:
      'Indicadores descriptivos de registros por proyecto; las prioridades digitales no son probabilidades de conflicto.',
    limitations: [
      'IRSA permanece independiente',
      'Acceso restringido a usuarios autenticados con permiso sobre el proyecto activo',
      'Compromisos vencidos contados únicamente cuando el estado lo indica expresamente',
      'No hay verificación automática de contenido en redes sociales',
    ],
  };
};

export type ManagementOverview = ReturnType<typeof managementOverview>;

/** CSV cell per RFC 4180, with a leading quote on text a spreadsheet would run as a formula. */
const cell = (value: string | number) => {
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const row = (values: readonly (string | number)[]) => `${values.map(cell).join(',')}\r\n`;

/** Percentages are Python floats once there are actions, so `50` prints as `50.0`. */
const FLOAT_METRICS = new Set(['completion_percent', 'average_progress']);
const pythonNumber = (key: string, value: number, totalActions: number) =>
  FLOAT_METRICS.has(key) && totalActions > 0 && Number.isInteger(value) ? `${value}.0` : value;

export const MANAGEMENT_CSV_FILENAME = 'sipges_rc28_reporte_gerencial.csv';

/** app.py `rc28_export_csv`: UTF-8 with BOM, CRLF rows like Python's csv.writer. */
export const managementCsv = (report: ManagementOverview) =>
  '\ufeff' +
  row(['SIPGES RC 2.8', 'Resumen gerencial', report.project_id, report.generated_at]) +
  row(['Indicador', 'Valor']) +
  Object.entries(report.metrics)
    .map(([k, v]) => row([k, pythonNumber(k, v, report.metrics.total_actions)]))
    .join('') +
  row([]) +
  row(['Acciones críticas', 'Responsable', 'Plazo', 'Estado', 'Avance (%)']) +
  report.critical_actions
    .map((x) => row([x.title, x.responsible, x.due_date, x.status, x.progress]))
    .join('') +
  row([]) +
  row(['Nota metodológica', report.methodology]);
