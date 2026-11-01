import type { RecordNeighbourhood } from '@sipges/contracts';
import { foldText, type Level, severityLevel } from '../../shared/lib/text.ts';
import { type Evidence, evidenceOf } from './evidence.ts';

/**
 * Operational intelligence of a territory (ODD territorial-operations): which signals were
 * documented there, which alerts they justify, what was done about them and which
 * commitments, communities and institutions are involved. Everything follows typed links
 * (explicit or read from reference fields, docs/adr/0011); names, localities and text never
 * relate two records here, and nothing is predicted.
 */

/** Records that document what happened in the territory. */
export const SIGNAL_MODULES = ['eventos', 'narrativas', 'demandas'] as const;
const SIGNALS = new Set<string>(SIGNAL_MODULES);

/**
 * Hop 1 from the signals: alerts they originate, responses to demands, actors involved and
 * supporting sources. Hop 2 only reaches the actions that attend those alerts, so an actor's
 * unrelated records elsewhere never enter the dossier.
 */
export const DOSSIER_HOPS = [
  ['origina', 'responde_a', 'participa_en', 'plantea', 'difunde', 'sustenta'],
  ['atiende'],
];

/** Payload fields the dossier reads beyond each object type's summary. */
export const DOSSIER_FIELDS = [
  'Fecha',
  'Fecha_Registro',
  'Fecha_Observacion',
  'Nivel_Verificacion',
  'Fuente_ID',
  'Estado_Informacion',
  'Fecha_Vencimiento',
  'Fecha_Limite',
  'Resultado',
  'Evidencia_Cierre',
  'Accion_Sugerida',
  'Tipo_Actor',
];

type Node = RecordNeighbourhood['nodes'][number];

export type DossierRef = { readonly module: string; readonly id: string; readonly title: string };

export type DossierSignal = DossierRef & {
  readonly typeLabel: string;
  readonly date: string;
  readonly evidence: Evidence;
  readonly basis: string;
};

export type DossierAction = DossierRef & {
  readonly status: string;
  readonly responsible: string;
  readonly due: string;
  readonly done: boolean;
  readonly overdue: boolean;
  readonly result: string;
};

export type DossierAlert = DossierRef & {
  readonly date: string;
  readonly level: Level;
  readonly status: string;
  readonly open: boolean;
  /** Signals that originate the alert, each with its information state. */
  readonly basis: readonly DossierSignal[];
  readonly actions: readonly DossierAction[];
  /** `Accion_Sugerida` as written in the alert, never generated. */
  readonly suggested: string;
};

export type DossierCommitment = DossierRef & {
  readonly status: string;
  readonly responsible: string;
  readonly due: string;
  readonly progress: number | null;
  readonly done: boolean;
  readonly overdue: boolean;
  /** Demands it responds to. */
  readonly demands: readonly DossierRef[];
};

export const ACTOR_GROUPS = ['comunidades', 'instituciones', 'otros'] as const;
export type ActorGroup = (typeof ACTOR_GROUPS)[number];
export const ACTOR_GROUP_LABELS: Readonly<Record<ActorGroup, string>> = {
  comunidades: 'Comunidades y organizaciones',
  instituciones: 'Instituciones',
  otros: 'Otros actores',
};

export type DossierActor = DossierRef & { readonly type: string; readonly group: ActorGroup };

export type Attention = {
  readonly kind:
    | 'alerta_sin_accion'
    | 'alerta_sin_sustento'
    | 'accion_vencida'
    | 'accion_sin_resultado'
    | 'compromiso_vencido'
    | 'demanda_sin_respuesta';
  readonly ref: DossierRef;
  readonly text: string;
};

export type Dossier = {
  readonly signals: readonly DossierSignal[];
  readonly alerts: readonly DossierAlert[];
  /** Actions that attend an alert of the dossier or respond to one of its demands. */
  readonly actions: readonly DossierAction[];
  readonly commitments: readonly DossierCommitment[];
  readonly actors: readonly DossierActor[];
  readonly attention: readonly Attention[];
  readonly truncated: boolean;
};

const CLOSED_ALERT = ['cerrad', 'descartad'];
const DONE_ACTION = ['cumplid', 'cancelad', 'cerrad', 'finalizad'];
const CANCELLED = ['cancelad'];
const DONE_COMMITMENT = ['cumplid', 'cerrad'];
const CLOSED_DEMAND = ['atendid', 'cerrad', 'descartad'];

const startsWithAny = (value: string, prefixes: readonly string[]) =>
  prefixes.some((prefix) => value.startsWith(prefix));

const field = (node: Node, name: string) => (node.fields[name] ?? '').trim();
const firstField = (node: Node, names: readonly string[]) =>
  names.map((name) => field(node, name)).find(Boolean) ?? '';

const key = (module: string, id: string) => `${module}\u0000${id}`;
const refOf = (node: Node): DossierRef => ({
  module: node.module,
  id: node.id,
  title: node.title,
});

/** A due date (yyyy-mm-dd) strictly before `today`. Free-text deadlines are never guessed. */
const isPast = (due: string, today: string) => /^\d{4}-\d{2}-\d{2}/.test(due) && due < today;

const percent = (value: string) => {
  const parsed = Number.parseFloat(value.replace('%', '').replace(',', '.'));
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : null;
};

const actorGroup = (type: string): ActorGroup => {
  const folded = foldText(type);
  if (folded.startsWith('comunidad') || folded.startsWith('organizacion')) return 'comunidades';
  if (folded.startsWith('institucion') || folded.includes('gobierno') || folded.includes('municip'))
    return 'instituciones';
  return 'otros';
};

const byDate = <T extends { date: string; title: string }>(a: T, b: T) =>
  b.date.localeCompare(a.date) || a.title.localeCompare(b.title);

/**
 * The dossier of the records in `seeds` from their typed neighbourhood. `today` (yyyy-mm-dd)
 * decides what is overdue; only explicit dates count.
 */
export const buildDossier = (
  graph: RecordNeighbourhood,
  seeds: readonly { module: string; id: string }[],
  today: string,
): Dossier => {
  const nodes = new Map(graph.nodes.map((node) => [key(node.module, node.id), node]));
  const node = (ref: { module: string; id: string }) => nodes.get(key(ref.module, ref.id));
  const seedKeys = new Set(seeds.map((s) => key(s.module, s.id)));
  const edges = graph.edges.map((edge) => ({
    type: edge.link_type,
    source: key(edge.source.module, edge.source.id),
    target: key(edge.target.module, edge.target.id),
  }));
  const linked = (type: string, from: (k: string) => boolean, to: (k: string) => boolean) =>
    edges.filter((e) => e.type === type && from(e.source) && to(e.target));
  const moduleOf = (k: string) => k.slice(0, k.indexOf('\u0000'));

  const signalNodes = [...seedKeys]
    .filter((k) => SIGNALS.has(moduleOf(k)))
    .flatMap((k) => nodes.get(k) ?? []);
  const signal = (n: Node): DossierSignal => {
    const { state, basis } = evidenceOf(n.fields);
    return {
      ...refOf(n),
      typeLabel: n.type_label,
      date: n.date ?? firstField(n, ['Fecha', 'Fecha_Registro', 'Fecha_Observacion']),
      evidence: state,
      basis,
    };
  };
  const signals = signalNodes.map(signal).sort(byDate);
  const signalByKey = new Map(signals.map((s) => [key(s.module, s.id), s]));
  const isSignal = (k: string) => signalByKey.has(k);
  const isModule = (module: string) => (k: string) => moduleOf(k) === module && nodes.has(k);

  const action = (n: Node): DossierAction => {
    const status = field(n, 'Estado');
    const folded = foldText(status);
    const done = startsWithAny(folded, DONE_ACTION);
    const due = firstField(n, ['Fecha_Vencimiento', 'Fecha_Limite']);
    return {
      ...refOf(n),
      status,
      responsible: field(n, 'Responsable'),
      due: due || field(n, 'Plazo'),
      done,
      overdue: !done && isPast(due, today),
      result: firstField(n, ['Resultado', 'Evidencia_Cierre']),
    };
  };

  const alertKeys = new Set(linked('origina', isSignal, isModule('alertas')).map((e) => e.target));
  const alerts: DossierAlert[] = [...alertKeys]
    .flatMap((k) => nodes.get(k) ?? [])
    .map((n) => {
      const k = key(n.module, n.id);
      const status = field(n, 'Estado');
      return {
        ...refOf(n),
        date: n.date ?? '',
        level: severityLevel(field(n, 'Nivel_Preliminar')),
        status,
        open: !startsWithAny(foldText(status), CLOSED_ALERT),
        basis: linked('origina', isSignal, (t) => t === k)
          .flatMap((e) => signalByKey.get(e.source) ?? [])
          .sort(byDate),
        actions: linked('atiende', isModule('acciones'), (t) => t === k)
          .flatMap((e) => nodes.get(e.source) ?? [])
          .map(action),
        suggested: field(n, 'Accion_Sugerida'),
      };
    })
    .sort(byDate);

  const demandSignal = (k: string) => moduleOf(k) === 'demandas' && isSignal(k);
  const actionKeys = new Set([
    ...linked('atiende', isModule('acciones'), (t) => alertKeys.has(t)).map((e) => e.source),
    ...linked('responde_a', isModule('acciones'), demandSignal).map((e) => e.source),
  ]);
  const actions = [...actionKeys].flatMap((k) => nodes.get(k) ?? []).map(action);

  const commitmentKeys = new Set(
    linked('responde_a', isModule('compromisos'), demandSignal).map((e) => e.source),
  );
  const commitments: DossierCommitment[] = [...commitmentKeys]
    .flatMap((k) => nodes.get(k) ?? [])
    .map((n) => {
      const status = field(n, 'Estado');
      const progress = percent(field(n, 'Avance_%'));
      const done = startsWithAny(foldText(status), DONE_COMMITMENT) || progress === 100;
      const due = firstField(n, ['Fecha_Vencimiento', 'Fecha_Limite']);
      const k = key(n.module, n.id);
      return {
        ...refOf(n),
        status,
        responsible: field(n, 'Responsable'),
        due: due || field(n, 'Plazo'),
        progress,
        done,
        overdue: !done && (foldText(status).startsWith('incumplid') || isPast(due, today)),
        demands: linked('responde_a', (s) => s === k, demandSignal).flatMap((e) => {
          const d = nodes.get(e.target);
          return d ? [refOf(d)] : [];
        }),
      };
    });

  const actorKeys = new Set([
    ...[...seedKeys].filter(isModule('actores')),
    ...['participa_en', 'plantea', 'difunde'].flatMap((type) =>
      linked(type, isModule('actores'), isSignal).map((e) => e.source),
    ),
  ]);
  const actors: DossierActor[] = [...actorKeys]
    .flatMap((k) => nodes.get(k) ?? [])
    .map((n) => {
      const type = field(n, 'Tipo_Actor');
      return { ...refOf(n), type, group: actorGroup(type) };
    })
    .sort((a, b) => a.title.localeCompare(b.title));

  const attention: Attention[] = [];
  for (const alert of alerts) {
    if (!alert.open) continue;
    if (!alert.actions.some((a) => !startsWithAny(foldText(a.status), CANCELLED)))
      attention.push({
        kind: 'alerta_sin_accion',
        ref: alert,
        text: 'Alerta abierta sin una acción vinculada que la atienda.',
      });
    if (alert.basis.length && alert.basis.every((s) => s.evidence !== 'observado'))
      attention.push({
        kind: 'alerta_sin_sustento',
        ref: alert,
        text: 'Alerta abierta sustentada solo en información estimada o hipotética; verificar antes de actuar.',
      });
  }
  for (const a of actions) {
    if (a.overdue)
      attention.push({ kind: 'accion_vencida', ref: a, text: `Acción vencida el ${a.due}.` });
    else if (a.done && !startsWithAny(foldText(a.status), CANCELLED) && !a.result)
      attention.push({
        kind: 'accion_sin_resultado',
        ref: a,
        text: 'Acción cumplida sin resultado documentado.',
      });
  }
  for (const c of commitments)
    if (c.overdue)
      attention.push({
        kind: 'compromiso_vencido',
        ref: c,
        text: foldText(c.status).startsWith('incumplid')
          ? 'Compromiso registrado como incumplido.'
          : `Compromiso vencido el ${c.due}${c.progress !== null ? ` con ${c.progress}% de avance` : ''}.`,
      });
  for (const demand of signals.filter((s) => s.module === 'demandas')) {
    const n = node(demand);
    if (!n || startsWithAny(foldText(field(n, 'Estado')), CLOSED_DEMAND)) continue;
    const k = key(demand.module, demand.id);
    const answered = edges.some(
      (e) =>
        e.type === 'responde_a' &&
        e.target === k &&
        (commitmentKeys.has(e.source) || actionKeys.has(e.source)),
    );
    if (!answered)
      attention.push({
        kind: 'demanda_sin_respuesta',
        ref: demand,
        text: 'Demanda sin compromiso ni acción vinculada que responda.',
      });
  }

  return {
    signals,
    alerts,
    actions,
    commitments,
    actors,
    attention,
    truncated: graph.truncated,
  };
};
