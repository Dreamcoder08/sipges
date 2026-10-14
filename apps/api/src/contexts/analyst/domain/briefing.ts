/**
 * Extractive briefings (docs/adr/0013): every sentence is copied or counted from records the
 * reader may see, and cites them by number. Nothing here invents facts, so the briefing is the
 * ground truth an optional language model may only rephrase.
 */

export type Subject = {
  readonly slug: string;
  readonly id: string;
  readonly typeLabel: string;
  readonly title: string;
  readonly date: string | null;
  readonly marking: string;
  readonly fields: Readonly<Record<string, string>>;
};

export type Connection = {
  readonly linkType: string;
  /** Reads from the subject towards `other`, e.g. "participa en". */
  readonly label: string;
  readonly inferred: boolean;
  readonly other: Subject;
};

export type Source = {
  readonly ref: number;
  readonly slug: string;
  readonly id: string;
  readonly typeLabel: string;
  readonly title: string;
};

export type Sentence = { readonly text: string; readonly refs: readonly number[] };
export type Section = { readonly title: string; readonly sentences: readonly Sentence[] };

export type Briefing = {
  readonly subject: Subject;
  readonly sources: readonly Source[];
  readonly sections: readonly Section[];
};

/** Bounds keep a briefing readable and a model prompt small. */
export const MAX_LISTED_CONNECTIONS = 8;
export const MAX_TIMELINE_ENTRIES = 6;
export const MAX_SIGNALS = 8;
const MAX_QUOTE = 160;

export const CLOSED = /cerrad|cumplid|resuelt|atendid|finaliz|archiv|descartad|complet|superad/i;
export const SEVERE = /alt|crít|crit|urgent|grave|roj/i;
const OPPOSED = /contra|oposi|opuest|rechaz|hostil/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

const quote = (value: string) => {
  const chars = Array.from(value.replace(/\s+/g, ' ').trim());
  return chars.length > MAX_QUOTE ? `${chars.slice(0, MAX_QUOTE - 1).join('')}…` : chars.join('');
};

const named = (subject: Subject) => `${subject.typeLabel} «${quote(subject.title)}»`;
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export const isOpen = (subject: Subject) => !CLOSED.test(subject.fields['Estado'] ?? '');

/** Signals worth an analyst's attention in one record, in priority order. */
const signalsOf = (subject: Subject, today: string): string[] => {
  const found: string[] = [];
  const fields = subject.fields;
  if (
    subject.slug === 'alertas' &&
    isOpen(subject) &&
    SEVERE.test(fields['Nivel_Preliminar'] ?? '')
  )
    found.push(
      `${named(subject)} sigue abierta con nivel ${quote(fields['Nivel_Preliminar'] ?? '')}.`,
    );
  if (subject.slug === 'compromisos' && isOpen(subject)) {
    const due = fields['Plazo'] ?? '';
    if (ISO_DATE.test(due) && due.slice(0, 10) < today)
      found.push(`${named(subject)} venció el ${due.slice(0, 10)} sin cerrarse.`);
  }
  if (subject.slug === 'demandas' && isOpen(subject) && SEVERE.test(fields['Prioridad'] ?? ''))
    found.push(
      `${named(subject)} tiene prioridad ${quote(fields['Prioridad'] ?? '')} y sigue abierta.`,
    );
  if (subject.slug === 'actores' && OPPOSED.test(fields['Posicion_Proyecto'] ?? ''))
    found.push(
      `${named(subject)} mantiene una posición ${quote(fields['Posicion_Proyecto'] ?? '')}.`,
    );
  return found;
};

/**
 * Builds the briefing of `subject` from its visible connections. `today` is an ISO date used to
 * flag overdue commitments; ordering is deterministic so the same data yields the same text.
 */
export const buildBriefing = (
  subject: Subject,
  connections: readonly Connection[],
  today: string,
): Briefing => {
  const sources: Source[] = [];
  const refs = new Map<string, number>();
  const cite = (record: Subject) => {
    const key = `${record.slug}\u0000${record.id}`;
    const known = refs.get(key);
    if (known) return known;
    const ref = sources.length + 1;
    refs.set(key, ref);
    sources.push({
      ref,
      slug: record.slug,
      id: record.id,
      typeLabel: record.typeLabel,
      title: record.title,
    });
    return ref;
  };
  const self = cite(subject);

  const overview: Sentence[] = [
    {
      text: `${named(subject)}${subject.date ? `, registrado con fecha ${subject.date}` : ''}.`,
      refs: [self],
    },
    ...Object.entries(subject.fields).map(([field, value]) => ({
      text: `${field.replace(/_/g, ' ')}: ${quote(value)}.`,
      refs: [self],
    })),
  ];

  const ordered = [...connections].sort(
    (a, b) =>
      Number(a.inferred) - Number(b.inferred) ||
      (b.other.date ?? '').localeCompare(a.other.date ?? '') ||
      a.other.typeLabel.localeCompare(b.other.typeLabel) ||
      a.other.id.localeCompare(b.other.id),
  );
  const groups = new Map<string, { total: number; inferred: number }>();
  for (const connection of ordered) {
    const group = groups.get(connection.label) ?? { total: 0, inferred: 0 };
    group.total += 1;
    if (connection.inferred) group.inferred += 1;
    groups.set(connection.label, group);
  }
  const network: Sentence[] = connections.length
    ? [
        {
          text: `Tiene ${plural(connections.length, 'vínculo', 'vínculos')} con ${plural(
            new Set(connections.map((c) => `${c.other.slug}\u0000${c.other.id}`)).size,
            'registro',
            'registros',
          )}.`,
          refs: [self],
        },
        ...[...groups.entries()]
          .sort(([a, x], [b, y]) => y.total - x.total || a.localeCompare(b))
          .map(([label, group]) => ({
            text: `${label}: ${plural(group.total, 'registro', 'registros')}${
              group.inferred
                ? ` (${group.inferred} inferido${group.inferred === 1 ? '' : 's'} de los datos)`
                : ''
            }.`,
            refs: [],
          })),
        ...ordered.slice(0, MAX_LISTED_CONNECTIONS).map((connection) => ({
          text: `${connection.label} ${named(connection.other)}${
            connection.other.date ? ` (${connection.other.date})` : ''
          }${connection.inferred ? ', vínculo inferido' : ''}.`,
          refs: [cite(connection.other)],
        })),
      ]
    : [
        {
          text: 'No tiene vínculos registrados ni inferidos. Vincularlo a actores, fuentes o eventos completaría su contexto.',
          refs: [self],
        },
      ];

  const dated = [subject, ...ordered.map((c) => c.other)]
    .filter(
      (record, index, all) =>
        record.date && all.findIndex((r) => r.slug === record.slug && r.id === record.id) === index,
    )
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.id.localeCompare(b.id))
    .slice(0, MAX_TIMELINE_ENTRIES);
  const timeline: Sentence[] = dated.map((record) => ({
    text: `${record.date}: ${named(record)}.`,
    refs: [cite(record)],
  }));

  const signals: Sentence[] = [
    ...signalsOf(subject, today).map((text) => ({ text, refs: [self] })),
    ...ordered.flatMap((connection) =>
      signalsOf(connection.other, today).map((text) => ({ text, refs: [cite(connection.other)] })),
    ),
    ...ordered
      .filter((connection) => connection.linkType === 'en_conflicto_con')
      .map((connection) => ({
        text: `Hay un conflicto registrado con ${named(connection.other)}.`,
        refs: [self, cite(connection.other)],
      })),
  ].slice(0, MAX_SIGNALS);
  const restricted = connections.filter((c) => c.other.marking === 'restringido').length;
  if (restricted)
    signals.push({
      text: `${plural(restricted, 'vínculo apunta', 'vínculos apuntan')} a información restringida.`,
      refs: [],
    });

  const sections: Section[] = [
    { title: 'Resumen', sentences: overview },
    { title: 'Red de vínculos', sentences: network },
  ];
  if (timeline.length) sections.push({ title: 'Cronología', sentences: timeline });
  sections.push({
    title: 'Señales de atención',
    sentences: signals.length
      ? signals
      : [
          {
            text: 'No se detectan alertas abiertas, compromisos vencidos ni conflictos registrados.',
            refs: [],
          },
        ],
  });
  return { subject, sources, sections };
};

/** Plain-text rendering with [n] citation markers, the only input a language model receives. */
export const briefingText = (briefing: Briefing) =>
  [
    ...briefing.sections.flatMap((section) => [
      `## ${section.title}`,
      ...section.sentences.map(
        (sentence) =>
          `- ${sentence.text}${sentence.refs.length ? ` ${sentence.refs.map((r) => `[${r}]`).join('')}` : ''}`,
      ),
    ]),
    '## Fuentes',
    ...briefing.sources.map(
      (source) => `[${source.ref}] ${source.typeLabel} ${source.id}: ${quote(source.title)}`,
    ),
  ].join('\n');

/** The citation numbers a text uses, or null when it cites a source the briefing lacks. */
export const citedRefs = (text: string, briefing: Briefing): number[] | null => {
  const known = new Set(briefing.sources.map((s) => s.ref));
  const used = [...text.matchAll(/\[(\d{1,4})\]/g)].map((m) => Number(m[1]));
  if (used.some((ref) => !known.has(ref))) return null;
  return [...new Set(used)].sort((a, b) => a - b);
};
