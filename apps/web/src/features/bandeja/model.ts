import type {
  SituationsReport,
  TerritorialAlert as TerritorialAlertSchema,
} from '@sipges/contracts';
import type { z } from 'zod';
import { objectHref } from '../../shared/lib/navigation.tsx';
import type { IconName } from '../../shared/ui/icons.ts';

type TerritorialAlert = z.infer<typeof TerritorialAlertSchema>;

export type Kind = 'alerta' | 'calidad' | 'situacion';
export const KIND_INFO: Readonly<
  Record<Kind, { singular: string; plural: string; icon: IconName }>
> = {
  alerta: { singular: 'Alerta', plural: 'Alertas', icon: 'bell' },
  calidad: { singular: 'Calidad', plural: 'Calidad de datos', icon: 'sliders' },
  situacion: { singular: 'Situación', plural: 'Situaciones', icon: 'layers' },
};
export const KINDS = (['alerta', 'calidad', 'situacion'] as const).map((value) => ({
  value,
  ...KIND_INFO[value],
}));

export type Urgency = 'urgent' | 'priority' | 'routine';
export const URGENCIES: readonly { value: Urgency; label: string }[] = [
  { value: 'urgent', label: 'Urgente' },
  { value: 'priority', label: 'Prioritario' },
  { value: 'routine', label: 'Rutina' },
];

/** Where the person decides when the inbox cannot do it inline. */
type Link = { href: string; label: string };

/** Who may decide an alert: a high-priority one needs two different people (docs/adr/0024). */
export type FourEyes = {
  required: boolean;
  firstValidator: string | null;
  canDecide: boolean;
  text: string;
};

type Common = {
  key: string;
  ref: string;
  title: string;
  urgency: Urgency;
  where: string | null;
  /** ISO date or timestamp the item has been waiting since, when the source records one. */
  since: string | null;
  summary: string;
  facts: readonly string[];
  owner: Link;
  evidence: readonly Link[];
};
export type PendingItem = Common &
  (
    | { kind: 'alerta'; alert: TerritorialAlert; fourEyes: FourEyes }
    | { kind: 'calidad' | 'situacion' }
  );

export const PENDING_STATUS = 'Pendiente de verificación';

export const fourEyesFor = (
  alert: Pick<TerritorialAlert, 'level' | 'first_validator'>,
  username: string,
  writable: boolean,
): FourEyes => {
  const required = alert.level === 'Alta';
  const first = alert.first_validator ?? null;
  const base = { required, firstValidator: first };
  if (!writable) return { ...base, canDecide: false, text: 'Tu rol es de consulta: solo lectura.' };
  if (!required)
    return {
      ...base,
      canDecide: true,
      text: 'No requiere cuatro ojos: una persona revisa y decide.',
    };
  if (!first)
    return {
      ...base,
      canDecide: true,
      text: 'Prioridad Alta: la deciden dos personas distintas. Tu aprobación sería la primera.',
    };
  if (first === username)
    return {
      ...base,
      canDecide: false,
      text: 'No puedes aprobarla: hiciste la primera validación. Otra persona debe confirmarla.',
    };
  return {
    ...base,
    canDecide: true,
    text: `${first} hizo la primera validación. Puedes confirmarla.`,
  };
};

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

const alertUrgency = (level: string): Urgency =>
  level === 'Alta' ? 'urgent' : level === 'Media' ? 'priority' : 'routine';

/** Digital territorial alerts that still wait for a first review (or a second validation). */
export const alertItems = (
  alerts: readonly TerritorialAlert[],
  username: string,
  writable: boolean,
): PendingItem[] =>
  alerts
    .filter((alert) => alert.status === PENDING_STATUS)
    .map((alert) => ({
      kind: 'alerta' as const,
      key: `alerta:${alert.id}`,
      ref: alert.id,
      title: clip(alert.excerpt, 120),
      urgency: alertUrgency(alert.level),
      where: alert.territory || null,
      since: alert.created_at,
      summary: alert.excerpt,
      facts: [
        `Prioridad ${alert.level} (${alert.score}) · ${alert.method}`,
        ...alert.suggestions,
        ...(alert.analyst_note ? [`Nota del analista: ${alert.analyst_note}`] : []),
      ],
      owner: {
        href: `/inteligencia-redes?alert=${encodeURIComponent(alert.id)}`,
        label: 'Abrir en Inteligencia de redes',
      },
      evidence: [
        ...(alert.source_record
          ? [
              {
                href: objectHref(alert.source_record.module.toLowerCase(), alert.source_record.id),
                label: `${alert.source_record.module} · ${alert.source_record.id}`,
              },
            ]
          : []),
      ],
      alert,
      fourEyes: fourEyesFor(alert, username, writable),
    }));

const SITUATION_URGENCY: Readonly<Record<string, Urgency | undefined>> = {
  Rojo: 'urgent',
  Naranja: 'priority',
  Amarillo: 'routine',
};

/** Open situations (Verde ones are stable) that have no alert raised from them yet. */
export const situationItems = (
  report: SituationsReport,
  raised: ReadonlySet<string>,
): PendingItem[] =>
  report.situations.flatMap((situation) => {
    const urgency = SITUATION_URGENCY[situation.level];
    if (!urgency || raised.has(situation.key)) return [];
    return [
      {
        kind: 'situacion' as const,
        key: `situacion:${situation.key}`,
        ref: situation.key,
        title: situation.label,
        urgency,
        where: situation.territories[0] ?? null,
        since: situation.last_date,
        summary: situation.summary,
        facts: situation.reasons.map((reason) => reason.text),
        owner: {
          href: '/bandeja?vista=situaciones',
          label: 'Abrir Situaciones para crear la alerta',
        },
        evidence: situation.records.slice(0, 6).map((record) => ({
          href: objectHref(record.module.toLowerCase(), record.id),
          label: `${record.module} · ${record.id}`,
        })),
      },
    ];
  });

/** A finding of the data-quality review, as the records screen computes it. */
export type QualityObservation = {
  module: string;
  id: string;
  title: string;
  field: string;
  reason: string;
};

/** The data-quality review lives in the records feature; the router injects it as a hook. */
export type QualityReview =
  | { state: 'loading' }
  | { state: 'error'; retry: () => void }
  | { state: 'ready'; observations: readonly QualityObservation[] };
export type UseQuality = (scope: string) => QualityReview;

const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** One item per record, listing every observation it has. */
export const qualityItems = (observations: readonly QualityObservation[]): PendingItem[] => {
  const byRecord = new Map<string, QualityObservation[]>();
  for (const item of observations) {
    const key = `${item.module}/${item.id}`;
    byRecord.set(key, [...(byRecord.get(key) ?? []), item]);
  }
  return [...byRecord.entries()].map(([key, list]) => {
    const [first] = list;
    return {
      kind: 'calidad' as const,
      key: `calidad:${key}`,
      ref: first?.id ?? key,
      title: `${first?.title ?? key}: ${list.length} ${list.length === 1 ? 'observación' : 'observaciones'}`,
      urgency: 'routine' as const,
      where: cap(first?.module ?? ''),
      since: null,
      summary:
        'Revisa la ficha y su evidencia antes de corregir; no se repara nada automáticamente.',
      facts: list.map((item) => `${item.field}: ${item.reason}`),
      owner: {
        href: objectHref(first?.module ?? '', first?.id ?? ''),
        label: `Revisar ${first?.id ?? ''}`,
      },
      evidence: [],
    };
  });
};

const URGENCY_RANK: Readonly<Record<Urgency, number>> = { urgent: 0, priority: 1, routine: 2 };

/** By urgency, then the oldest waiting first; items with no date go last in their group. */
export const orderItems = (items: readonly PendingItem[]): PendingItem[] =>
  [...items].sort(
    (a, b) =>
      URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] ||
      (a.since ?? '9999').localeCompare(b.since ?? '9999') ||
      a.key.localeCompare(b.key),
  );

export const groupItems = (items: readonly PendingItem[]) =>
  URGENCIES.map((urgency) => ({
    ...urgency,
    items: items.filter((item) => item.urgency === urgency.value),
  })).filter((group) => group.items.length > 0);

/** «hace 3 d» for the time an item has been waiting; null when the source has no date. */
export const ageLabel = (since: string | null, now: number): string | null => {
  if (!since) return null;
  const then = Date.parse(since);
  if (Number.isNaN(then)) return null;
  const hours = Math.max(0, Math.floor((now - then) / 3_600_000));
  if (hours < 1) return 'hace minutos';
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.floor(hours / 24)} d`;
};
