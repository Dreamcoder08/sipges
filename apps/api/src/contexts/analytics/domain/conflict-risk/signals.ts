import { isTerminalStatus, recordDueDate } from '@sipges/kernel';

/**
 * Records, territorial alerts and IRSA snapshots as dated signals per unit (docs/adr/0031 §1–2).
 * Pure: no I/O. Units come only from the record's own territory and actor fields.
 */

export type RiskRecord = {
  readonly module: string;
  readonly id: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** ISO timestamp of the record's last update; null when unknown. */
  readonly updatedAt: string | null;
};

export type RiskAlert = {
  readonly id: string;
  /** ISO timestamp. */
  readonly createdAt: string;
  readonly territory: string | null;
  /** Alta, Media or Baja. */
  readonly level: string;
  readonly status: string;
  readonly reviewedAt: string | null;
};

export type IrsaPoint = { readonly ts: string; readonly irsa: number };

export type RiskInput = {
  readonly records: readonly RiskRecord[];
  readonly alerts: readonly RiskAlert[];
  readonly irsa: readonly IrsaPoint[];
  /** `YYYY-MM-DD`, the prediction day. */
  readonly today: string;
};

export type SignalKind = 'demand' | 'commitment' | 'narrative' | 'alert' | 'escalation' | 'event';

export type SourceRef = {
  readonly module: string;
  readonly id: string;
  readonly title: string;
  /** `YYYY-MM-DD`. */
  readonly date: string;
};

export type Signal = SourceRef & {
  readonly kind: SignalKind;
  /** Unit keys: `L:<folded locality>` and `A:<folded actor>`. */
  readonly units: readonly string[];
  readonly weight: number;
  /** Day the record became closed or discarded, when it is today; null while open. */
  readonly closedOn: string | null;
  /** Commitments only. */
  readonly dueDate: string | null;
  /** Narratives only: critical or negative tone. */
  readonly negative: boolean;
};

/** Territorial alerts live in Digital Intelligence; their links open the alerts inbox. */
export const TERRITORIAL_ALERT_MODULE = 'Alertas_Territoriales';
const GENERATED_ORIGIN = 'SIPGES';

export const TERRITORY_FIELDS = ['Territorio', 'Comunidad', 'Localidad', 'Distrito'] as const;

type Spec = {
  readonly dates: readonly string[];
  readonly titles: readonly string[];
  readonly actors: readonly string[];
};

const SPECS: Readonly<Record<string, Spec>> = {
  Demandas: {
    dates: ['Fecha_Registro', 'Fecha'],
    titles: ['Tema', 'Descripcion'],
    actors: ['Actor/Grupo'],
  },
  Compromisos: { dates: ['Fecha'], titles: ['Descripcion'], actors: ['Actor/Entidad'] },
  Narrativas: {
    dates: ['Fecha_Inicio', 'Fecha_Observacion'],
    titles: ['Tema', 'Descripcion'],
    actors: ['Actor_Relacionado'],
  },
  Alertas: { dates: ['Fecha'], titles: ['Causa'], actors: ['Actor', 'Actor_Relacionado'] },
  Eventos: {
    dates: ['Fecha'],
    titles: ['Descripcion_Hecho', 'Tipo_Evento'],
    actors: ['Actor_Principal'],
  },
};

export const RISK_MODULES = Object.keys(SPECS);

export const fold = (value: unknown) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const text = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';

const first = (payload: RiskRecord['payload'], keys: readonly string[]) => {
  for (const key of keys) {
    const value = text(payload[key]);
    if (value) return value;
  }
  return '';
};

/** `YYYY-MM-DD` from ISO or `dd/mm/yyyy`; null when the value is not a real date. */
export const dayOf = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  const local = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(value);
  const day = iso
    ? `${iso[1]}-${iso[2]}-${iso[3]}`
    : local
      ? `${local[3]}-${local[2]?.padStart(2, '0')}-${local[1]?.padStart(2, '0')}`
      : null;
  if (!day) return null;
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day ? null : day;
};

const DAY_MS = 86_400_000;
export const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** Rojo, crítico or muy alta: 2; naranja or alta: 1.5; anything else 1. */
const severityOf = (value: string) => {
  const v = fold(value);
  if (/rojo|critic|muy alta/.test(v)) return 2;
  if (/naranja|alta|alto/.test(v)) return 1.5;
  return 1;
};

const NEGATIVE_TONE = /critic|negativ|hostil|advers/;
const DISCARDED = /^descartad[oa]$/;

const unitsOf = (payload: RiskRecord['payload'], actors: readonly string[], names: Names) => {
  const units: string[] = [];
  const locality = first(payload, TERRITORY_FIELDS);
  if (locality) units.push(names.add('L', locality));
  for (const key of actors)
    for (const part of text(payload[key]).split(/[;,]/)) {
      const name = part.trim();
      if (name.length > 1) units.push(names.add('A', name));
    }
  return [...new Set(units)];
};

/** Display name of each unit key: the first spelling seen. */
export class Names {
  readonly byKey = new Map<string, string>();
  add(prefix: 'L' | 'A', name: string) {
    const key = `${prefix}:${fold(name)}`;
    if (!this.byKey.has(key)) this.byKey.set(key, name);
    return key;
  }
}

const shortTitle = (value: string, fallback: string) => {
  const title = value || fallback;
  return title.length > 120 ? `${title.slice(0, 117)}…` : title;
};

/** Every record of the tenant counts: the tenant is the project (S13), whatever `Proyecto_ID` says. */
const recordSignals = (record: RiskRecord, names: Names): Signal[] => {
  const spec = SPECS[record.module];
  if (!spec) return [];
  const { payload } = record;
  if (record.module === 'Alertas' && text(payload['Origen']) === GENERATED_ORIGIN) return [];
  const dueDate = record.module === 'Compromisos' ? recordDueDate(payload) : null;
  const date = dayOf(first(payload, spec.dates)) ?? dueDate;
  if (!date) return [];
  const units = unitsOf(payload, spec.actors, names);
  if (!units.length) return [];
  const state = payload['Estado'];
  // Closed today: when it was last updated, or its own date when that is unknown (docs/adr/0031 §2).
  const closedDay = dayOf(record.updatedAt) ?? date;
  const base = {
    module: record.module,
    id: record.id,
    title: shortTitle(first(payload, spec.titles), record.id),
    date,
    units,
    dueDate,
    negative: false,
  };
  switch (record.module) {
    case 'Demandas':
      return [
        {
          ...base,
          kind: 'demand',
          weight: fold(payload['Prioridad']) === 'alta' ? 1.5 : 1,
          closedOn: isTerminalStatus(state) ? closedDay : null,
        },
      ];
    case 'Compromisos':
      return [
        {
          ...base,
          kind: 'commitment',
          weight: 1,
          closedOn: isTerminalStatus(state) ? closedDay : null,
        },
      ];
    case 'Narrativas':
      return [
        {
          ...base,
          kind: 'narrative',
          weight: 1,
          closedOn: null,
          negative: NEGATIVE_TONE.test(fold(payload['Tono'])),
        },
      ];
    case 'Alertas': {
      const discarded = DISCARDED.test(fold(state));
      const severity = severityOf(first(payload, ['Nivel_Preliminar', 'Nivel']));
      const alert: Signal = {
        ...base,
        kind: 'alert',
        weight: severity,
        closedOn: discarded ? closedDay : null,
      };
      return severity >= 1.5 && !discarded
        ? [alert, { ...alert, kind: 'escalation', weight: 1 }]
        : [alert];
    }
    default: {
      const event: Signal = { ...base, kind: 'event', weight: 1, closedOn: null };
      const severity = severityOf(first(payload, ['Nivel_Preliminar', 'Relevancia_Preliminar']));
      return severity >= 1.5 ? [event, { ...event, kind: 'escalation' }] : [event];
    }
  }
};

const ALERT_WEIGHT: Readonly<Record<string, number>> = { alta: 2, media: 1.5 };

const alertSignals = (alert: RiskAlert, names: Names): Signal[] => {
  const date = dayOf(alert.createdAt);
  if (!date || !alert.territory?.trim()) return [];
  const discarded = DISCARDED.test(fold(alert.status));
  const signal: Signal = {
    module: TERRITORIAL_ALERT_MODULE,
    id: alert.id,
    title: `Alerta territorial ${alert.level}`,
    date,
    units: [names.add('L', alert.territory.trim())],
    kind: 'alert',
    weight: ALERT_WEIGHT[fold(alert.level)] ?? 1,
    closedOn: discarded ? (dayOf(alert.reviewedAt) ?? date) : null,
    dueDate: null,
    negative: false,
  };
  return fold(alert.level) === 'alta' && !discarded
    ? [signal, { ...signal, kind: 'escalation', weight: 1 }]
    : [signal];
};

export type SignalIndex = {
  readonly byUnit: ReadonlyMap<string, readonly Signal[]>;
  readonly names: ReadonlyMap<string, string>;
  /** Earliest signal day, null without signals. */
  readonly firstDay: string | null;
};

/** Every signal of the input, grouped by unit and sorted by date. */
export const indexSignals = (input: RiskInput): SignalIndex => {
  const names = new Names();
  const signals = [
    ...input.records.flatMap((r) => recordSignals(r, names)),
    ...input.alerts.flatMap((a) => alertSignals(a, names)),
  ].filter((s) => s.date <= input.today);
  const byUnit = new Map<string, Signal[]>();
  for (const signal of signals)
    for (const unit of signal.units) {
      const list = byUnit.get(unit) ?? [];
      list.push(signal);
      byUnit.set(unit, list);
    }
  for (const list of byUnit.values()) list.sort((a, b) => a.date.localeCompare(b.date));
  const firstDay = signals.reduce<string | null>(
    (min, s) => (min === null || s.date < min ? s.date : min),
    null,
  );
  return { byUnit, names: names.byKey, firstDay };
};
