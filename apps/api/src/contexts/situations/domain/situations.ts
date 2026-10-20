import { LEVELS, type Level, type ProjectSettings } from './settings.ts';
import {
  type Signal,
  type SourceRecord,
  TERRITORY_FIELDS,
  first,
  fold,
  toSignal,
} from './signals.ts';

/**
 * Situations: records that share a topic, an actor or a recorded territory within the
 * project's window, weighted by recency (docs/adr/0020 §2-3). Pure and deterministic.
 */

export type KeyKind = 'tema' | 'actor' | 'territorio';

export type Citation = {
  readonly module: string;
  readonly id: string;
  readonly title: string;
  readonly date: string;
};

export type Reason = { readonly text: string; readonly records: readonly string[] };

export type Trend = 'en aumento' | 'estable' | 'en descenso';

export type Situation = {
  readonly key: string;
  readonly kind: KeyKind;
  readonly label: string;
  readonly level: Level;
  readonly score: number;
  readonly trend: Trend;
  readonly summary: string;
  readonly reasons: readonly Reason[];
  readonly recommendations: readonly string[];
  readonly records: readonly Citation[];
  readonly actors: readonly string[];
  readonly territories: readonly string[];
  readonly topics: readonly string[];
  readonly lastDate: string;
  /** Lessons the team recorded earlier about the same territory, topic or actor. */
  readonly lessons?: readonly Lesson[];
};

export type Lesson = { readonly id: string; readonly date: string; readonly learned: string };

/** Stored module of territorial lessons (docs/adr/0024 §4). */
export const LESSONS_MODULE = 'Lecciones_Territoriales';

/**
 * Past lessons that share the situation's key. Lessons inform the person; they never weigh in
 * the score or the colour, and a lesson without what was learned is not shown.
 */
export const attachLessons = (
  situations: readonly Situation[],
  lessons: readonly SourceRecord[],
): Situation[] => {
  const keyed = lessons.flatMap((r) => {
    const learned = first(r.payload, ['Aprendido']);
    if (!learned) return [];
    const lesson: Lesson = { id: r.id, date: first(r.payload, ['Fecha']), learned };
    const keys = [
      ['territorio', first(r.payload, TERRITORY_FIELDS)],
      ['tema', first(r.payload, ['Tema'])],
      ['actor', first(r.payload, ['Actor'])],
    ]
      .filter(([, label]) => label)
      .map(([kind, label]) => `${kind}:${fold(label ?? '')}`);
    return [{ lesson, keys }];
  });
  return situations.map((s) => ({
    ...s,
    lessons: keyed
      .filter((k) => k.keys.includes(s.key))
      .map((k) => k.lesson)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
  }));
};

const KIND_LABEL: Readonly<Record<KeyKind, string>> = {
  tema: 'el tema',
  actor: 'el actor',
  territorio: 'el territorio',
};

const RECENT_DAYS = 7;
/** Weeks before the last one that form the baseline rate. */
const BASELINE_WEEKS = 4;
const MAX_SITUATIONS = 30;
const MAX_LISTED = 3;

/** Fixed conditions of the recommendation catalogue (§3); texts are editable per project. */
export const RECOMMENDATION_IDS = [
  'verificar',
  'seguimiento',
  'contactar',
  'reunion',
  'monitoreo',
  'narrativas',
  'buzon',
  'inmediata',
] as const;
export type RecommendationId = (typeof RECOMMENDATION_IDS)[number];

export const DEFAULT_RECOMMENDATIONS: Readonly<Record<RecommendationId, string>> = {
  verificar: 'Verificar la información con las fuentes y el equipo de campo antes de escalar.',
  seguimiento: 'Hacer seguimiento a la demanda o compromiso relacionado y documentar la respuesta.',
  contactar: 'Contactar a {actores} para conocer su posición.',
  reunion: 'Coordinar una reunión con los actores involucrados.',
  monitoreo: 'Aumentar la frecuencia de monitoreo de este tema.',
  narrativas: 'Contrastar las publicaciones con fuentes independientes antes de responder.',
  buzon: 'Responder los casos del buzón relacionados dentro del plazo.',
  inmediata: 'Escalar al responsable del proyecto y activar la atención inmediata.',
};

export const RECOMMENDATION_CONDITIONS: Readonly<Record<RecommendationId, string>> = {
  verificar: 'Siempre',
  seguimiento: 'Hay demandas o compromisos',
  contactar: 'Hay actores y el nivel es Amarillo o superior',
  reunion: 'Nivel Naranja o Rojo',
  monitoreo: 'La situación está en aumento',
  narrativas: 'Hay publicaciones o narrativas',
  buzon: 'Hay casos del buzón',
  inmediata: 'Nivel Rojo',
};

const round = (n: number) => Math.round(n * 100) / 100;

/** "A", "A y B", "A, B y C" (with "y N más" past three). */
export const listNames = (names: readonly string[]) => {
  const shown = names.slice(0, MAX_LISTED);
  const rest = names.length - shown.length;
  const items = rest > 0 ? [...shown, `${rest} más`] : shown;
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} y ${items.at(-1)}`;
};

const counted = (values: readonly string[]) => {
  const counts = new Map<string, { name: string; count: number }>();
  for (const value of values) {
    const entry = counts.get(fold(value)) ?? { name: value, count: 0 };
    entry.count += 1;
    counts.set(fold(value), entry);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
};

const levelFor = (score: number, thresholds: ProjectSettings['thresholds']): Level =>
  score >= thresholds.Rojo
    ? 'Rojo'
    : score >= thresholds.Naranja
      ? 'Naranja'
      : score >= thresholds.Amarillo
        ? 'Amarillo'
        : 'Verde';

export const trendOf = (signals: readonly Signal[]) => {
  const recent = signals.filter((s) => s.ageDays < RECENT_DAYS).length;
  const before = signals.filter(
    (s) => s.ageDays >= RECENT_DAYS && s.ageDays < RECENT_DAYS * (BASELINE_WEEKS + 1),
  ).length;
  const weekly = before / BASELINE_WEEKS;
  const trend: Trend =
    recent >= 2 && recent > weekly * 1.5
      ? 'en aumento'
      : recent === 0 && before > 0
        ? 'en descenso'
        : 'estable';
  return { trend, recent, weekly: round(weekly) };
};

const NEGATIVE = /negativ|critic|hostil|adverso/;

/** Share of negative tone among dated narratives, last half of the window against the first. */
export const toneShift = (signals: readonly Signal[], windowDays: number) => {
  const narratives = signals.filter((s) => s.module === 'Narrativas' && s.tone);
  const split = windowDays / 6;
  const recent = narratives.filter((s) => s.ageDays < split);
  const earlier = narratives.filter((s) => s.ageDays >= split);
  if (recent.length < 2 || earlier.length < 1) return null;
  const share = (list: readonly Signal[]) =>
    Math.round((list.filter((s) => NEGATIVE.test(s.tone ?? '')).length * 100) / list.length);
  const now = share(recent);
  const then = share(earlier);
  return Math.abs(now - then) >= 25 ? { now, then, recent } : null;
};

const cite = (signals: readonly Signal[]) => signals.map((s) => `${s.module}:${s.id}`);

const recommend = (
  level: Level,
  trend: Trend,
  signals: readonly Signal[],
  actors: readonly string[],
  texts: Readonly<Record<RecommendationId, string>>,
) => {
  const has = (module: string) => signals.some((s) => s.module === module);
  const rank = LEVELS.indexOf(level);
  const when: Record<RecommendationId, boolean> = {
    inmediata: level === 'Rojo',
    reunion: rank >= 2,
    contactar: actors.length > 0 && rank >= 1,
    seguimiento: has('Demandas') || has('Compromisos'),
    monitoreo: trend === 'en aumento',
    narrativas: has('Narrativas'),
    buzon: has('Buzon'),
    verificar: true,
  };
  const order: readonly RecommendationId[] = [
    'inmediata',
    'reunion',
    'contactar',
    'seguimiento',
    'monitoreo',
    'narrativas',
    'buzon',
    'verificar',
  ];
  return order
    .filter((id) => when[id])
    .map((id) =>
      texts[id].replaceAll('{actores}', listNames(actors) || 'los actores involucrados'),
    );
};

const buildSituation = (
  kind: KeyKind,
  label: string,
  signals: readonly Signal[],
  settings: ProjectSettings,
  texts: Readonly<Record<RecommendationId, string>>,
): Situation => {
  const sorted = [...signals].sort((a, b) => a.ageDays - b.ageDays || (a.id < b.id ? -1 : 1));
  const score = round(
    sorted.reduce((sum, s) => sum + 0.5 ** (s.ageDays / settings.halfLifeDays) * s.severity, 0),
  );
  const { trend, recent, weekly } = trendOf(sorted);
  const base = levelFor(score, settings.thresholds);
  const raised = trend === 'en aumento' && base !== 'Rojo';
  const level = raised ? (LEVELS[LEVELS.indexOf(base) + 1] ?? base) : base;
  const actors = counted(sorted.flatMap((s) => s.actors)).filter(
    (a) => !(kind === 'actor' && fold(a.name) === fold(label)),
  );
  const territories = counted(sorted.flatMap((s) => (s.territory ? [s.territory] : []))).filter(
    (t) => !(kind === 'territorio' && fold(t.name) === fold(label)),
  );
  const topics = counted(sorted.flatMap((s) => s.topics)).filter(
    (t) => !(kind === 'tema' && fold(t.name) === fold(label)),
  );
  const span = Math.max(1, (sorted.at(-1)?.ageDays ?? 0) - (sorted[0]?.ageDays ?? 0) + 1);
  const recentWord = recent ? 'recientes ' : '';

  const reasons: Reason[] = [
    {
      text: `${sorted.length} registros relacionados con ${KIND_LABEL[kind]} «${label}» en ${span} día(s).`,
      records: cite(sorted),
    },
  ];
  if (actors.length) {
    const named = actors.map((a) => (a.count > 1 ? `${a.name} (${a.count})` : a.name));
    reasons.push({
      text: `Participan ${listNames(named)}.`,
      records: cite(sorted.filter((s) => s.actors.length)),
    });
  }
  if (territories.length) {
    reasons.push({
      text: `Territorio registrado: ${listNames(territories.map((t) => t.name))}.`,
      records: cite(sorted.filter((s) => s.territory)),
    });
  }
  if (kind !== 'tema' && topics.length) {
    reasons.push({
      text: `Temas en común: ${listNames(topics.map((t) => t.name))}.`,
      records: cite(sorted.filter((s) => s.topics.length)),
    });
  }
  if (trend === 'en aumento') {
    reasons.push({
      text: `En aumento: ${recent} registro(s) en los últimos ${RECENT_DAYS} días frente a ${weekly} por semana en las ${BASELINE_WEEKS} semanas anteriores${raised ? `; por eso el nivel sube de ${base} a ${level}` : ''}.`,
      records: cite(sorted.filter((s) => s.ageDays < RECENT_DAYS)),
    });
  } else if (trend === 'en descenso') {
    reasons.push({
      text: `En descenso: sin registros en los últimos ${RECENT_DAYS} días.`,
      records: [],
    });
  }
  const severe = sorted.filter((s) => s.severity > 1);
  if (severe.length) {
    reasons.push({
      text: `${severe.length} registro(s) con prioridad o nivel alto.`,
      records: cite(severe),
    });
  }
  const tone = toneShift(sorted, settings.windowDays);
  if (tone) {
    reasons.push({
      text: `Cambio de narrativa: el tono negativo pasa de ${tone.then} % a ${tone.now} % en las publicaciones más recientes.`,
      records: cite(tone.recent),
    });
  }
  reasons.push({
    text: `Puntaje ${score}: cada registro pesa la mitad cada ${settings.halfLifeDays} días y más si su prioridad es alta.`,
    records: [],
  });

  const who = actors.length ? ` y participación de ${listNames(actors.map((a) => a.name))}` : '';
  const about = kind === 'tema' ? label.toLowerCase() : `${KIND_LABEL[kind]} ${label}`;
  const summary = `${level} – ${settings.levelMeanings[level]}: existen ${sorted.length} registros ${recentWord}relacionados con ${about}${who}${trend === 'en aumento' ? ', en aumento' : ''}.`;

  return {
    key: `${kind}:${fold(label)}`,
    kind,
    label,
    level,
    score,
    trend,
    summary,
    reasons,
    recommendations: recommend(
      level,
      trend,
      sorted,
      actors.map((a) => a.name),
      texts,
    ),
    records: sorted.map((s) => ({ module: s.module, id: s.id, title: s.title, date: s.date })),
    actors: actors.map((a) => a.name),
    territories: territories.map((t) => t.name),
    topics: topics.map((t) => t.name),
    lastDate: sorted[0]?.date ?? '',
  };
};

/**
 * Narratives and media at a glance: repeated topics, platforms and tone change (S7). Rules
 * today; the same structured view is what a future assistant would read (ADR 0020 §5).
 */
export type NarrativeOverview = {
  readonly total: number;
  readonly recent: number;
  readonly topics: readonly { name: string; count: number; recent: number }[];
  readonly platforms: readonly { name: string; count: number }[];
  readonly tone: { readonly now: number; readonly then: number } | null;
};

export const narrativeOverview = (
  signals: readonly Signal[],
  platforms: ReadonlyMap<string, string>,
  windowDays: number,
): NarrativeOverview => {
  const narratives = signals.filter((s) => s.module === 'Narrativas');
  const isRecent = (s: Signal) => s.ageDays < RECENT_DAYS;
  const topics = counted(narratives.flatMap((s) => s.topics))
    .map(({ name, count }) => ({
      name,
      count,
      recent: narratives.filter((s) => isRecent(s) && s.topics.includes(name)).length,
    }))
    .filter((t) => t.count >= 2)
    .slice(0, 10);
  const tone = toneShift(narratives, windowDays);
  return {
    total: narratives.length,
    recent: narratives.filter(isRecent).length,
    topics,
    platforms: counted(narratives.flatMap((s) => platforms.get(s.id) ?? [])).slice(0, 8),
    tone: tone ? { now: tone.now, then: tone.then } : null,
  };
};

export type SituationsReport = {
  readonly situations: readonly Situation[];
  readonly narratives: NarrativeOverview;
  /** Records that could join a situation but carry no usable date. */
  readonly undated: number;
  readonly considered: number;
};

export const findSituations = (
  records: readonly SourceRecord[],
  settings: ProjectSettings,
  today: string,
  texts: Readonly<Record<RecommendationId, string>> = DEFAULT_RECOMMENDATIONS,
): SituationsReport => {
  const signals: Signal[] = [];
  let undated = 0;
  for (const record of records) {
    const signal = toSignal(record, today);
    if (signal === 'undated') undated += 1;
    if (signal === 'undated' || !signal) continue;
    if (signal.ageDays <= settings.windowDays) signals.push(signal);
  }

  const groups = new Map<string, { kind: KeyKind; label: string; signals: Signal[] }>();
  const add = (kind: KeyKind, label: string, signal: Signal) => {
    const key = `${kind}:${fold(label)}`;
    const group = groups.get(key) ?? { kind, label, signals: [] };
    group.signals.push(signal);
    groups.set(key, group);
  };
  for (const signal of signals) {
    for (const topic of signal.topics) add('tema', topic, signal);
    for (const actor of signal.actors) add('actor', actor, signal);
    if (signal.territory) add('territorio', signal.territory, signal);
  }

  const seen = new Set<string>();
  const situations = [...groups.values()]
    .filter((g) => g.signals.length >= 2)
    .map((g) => buildSituation(g.kind, g.label, g.signals, settings, texts))
    .sort(
      (a, b) =>
        LEVELS.indexOf(b.level) - LEVELS.indexOf(a.level) ||
        b.score - a.score ||
        (a.key < b.key ? -1 : 1),
    )
    // The same records grouped under another key add nothing new.
    .filter((s) => {
      const set = s.records.map((r) => `${r.module}:${r.id}`).join('|');
      if (seen.has(set)) return false;
      seen.add(set);
      return true;
    })
    .slice(0, MAX_SITUATIONS);
  const platforms = new Map(
    records
      .filter((r) => r.module === 'Narrativas')
      .flatMap((r) => {
        const name = String(r.payload['Plataforma/Fuente'] ?? '').trim();
        return name ? [[r.id, name] as const] : [];
      }),
  );
  return {
    situations,
    narratives: narrativeOverview(signals, platforms, settings.windowDays),
    undated,
    considered: signals.length,
  };
};
