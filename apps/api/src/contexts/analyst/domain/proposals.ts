import { type Connection, type Subject, SEVERE, isOpen } from './briefing.ts';

/**
 * Actions the analyst proposes and a person approves or discards (docs/adr/0014 §8). Each
 * proposal has a stable fingerprint so a decision is remembered and never proposed again.
 */
export type ProposedLink = {
  readonly linkType: string;
  readonly source: { readonly slug: string; readonly id: string };
  readonly target: { readonly slug: string; readonly id: string };
};

export type ProposedRecord = {
  readonly slug: string;
  readonly payload: Readonly<Record<string, string>>;
};

export type Proposal = {
  readonly fingerprint: string;
  readonly kind: 'link' | 'record';
  readonly title: string;
  readonly reason: string;
  readonly link: ProposedLink | null;
  readonly record: ProposedRecord | null;
};

/** A text mention found by the Ontology context, with the link it suggests. */
export type MentionFound = ProposedLink & {
  readonly other: Subject;
  /** Reads source → target, e.g. "participa en". */
  readonly label: string;
  readonly holder: 'self' | 'other';
  readonly field: string;
  readonly excerpt: string;
};

const MAX_TITLE = 80;
const short = (text: string) => {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length > MAX_TITLE ? `${chars.slice(0, MAX_TITLE - 1).join('')}…` : chars.join('');
};

const ref = (end: { slug: string; id: string }) => `${end.slug}/${end.id}`;
export const linkFingerprint = (link: ProposedLink) =>
  `link:${link.linkType}:${ref(link.source)}:${ref(link.target)}`;

const addDays = (today: string, days: number) => {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

export const mentionProposal = (subject: Subject, mention: MentionFound): Proposal => {
  const subjectIsSource = mention.source.slug === subject.slug && mention.source.id === subject.id;
  const [from, to] = subjectIsSource ? [subject, mention.other] : [mention.other, subject];
  const holder = mention.holder === 'self' ? subject : mention.other;
  return {
    fingerprint: linkFingerprint(mention),
    kind: 'link',
    title: `Vincular: ${from.typeLabel} «${short(from.title)}» ${mention.label} ${to.typeLabel} «${short(to.title)}»`,
    reason: `${holder.typeLabel} ${holder.id} lo menciona en ${mention.field}: «${mention.excerpt}»`,
    link: { linkType: mention.linkType, source: mention.source, target: mention.target },
    record: null,
  };
};

const has = (connections: readonly Connection[], linkType: string) =>
  connections.some((c) => c.linkType === linkType);

/** Follow-up records an open, severe item lacks; once created they link back by inference. */
export const followUpProposals = (
  subject: Subject,
  connections: readonly Connection[],
  today: string,
): Proposal[] => {
  const fields = subject.fields;
  const title = short(subject.title);
  if (
    subject.slug === 'alertas' &&
    isOpen(subject) &&
    SEVERE.test(fields['Nivel_Preliminar'] ?? '') &&
    !has(connections, 'atiende')
  ) {
    return [
      {
        fingerprint: `record:acciones:${ref(subject)}`,
        kind: 'record',
        title: `Crear una acción de prevención para la alerta ${subject.id}`,
        reason: `La alerta sigue abierta con nivel ${fields['Nivel_Preliminar']} y ninguna acción la atiende.`,
        link: null,
        record: {
          slug: 'acciones',
          payload: {
            Accion: `Atender alerta ${subject.id}: ${title}`,
            Alerta_Asociada: subject.id,
            Estado: 'Pendiente',
            Plazo: addDays(today, 7),
          },
        },
      },
    ];
  }
  if (
    subject.slug === 'demandas' &&
    isOpen(subject) &&
    SEVERE.test(fields['Prioridad'] ?? '') &&
    !has(connections, 'responde_a')
  ) {
    return [
      {
        fingerprint: `record:compromisos:${ref(subject)}`,
        kind: 'record',
        title: `Registrar un compromiso de respuesta a la demanda ${subject.id}`,
        reason: `La demanda tiene prioridad ${fields['Prioridad']}, sigue abierta y nada responde a ella.`,
        link: null,
        record: {
          slug: 'compromisos',
          payload: {
            Descripcion: `Responder a la demanda ${subject.id}: ${title}`,
            Demanda_Asociada: subject.id,
            Estado: 'Pendiente',
            Plazo: addDays(today, 15),
          },
        },
      },
    ];
  }
  return [];
};
