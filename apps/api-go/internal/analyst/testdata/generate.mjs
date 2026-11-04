// Records the TypeScript analyst and ontology domain on synthetic inputs, for the Go port's
// parity test (../domain/fixtures_test.go). Run from the repository root after changing either side:
//
//   node apps/api-go/internal/analyst/testdata/generate.mjs          # rewrites the fixture
//   node apps/api-go/internal/analyst/testdata/generate.mjs --check  # exit 1 when it drifted
//
// Every input is synthetic and built from a fixed seed: no real record is read.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { buildBriefing } from '../../../../api/src/contexts/analyst/domain/briefing.ts';
import {
  followUpProposals,
  mentionProposal,
} from '../../../../api/src/contexts/analyst/domain/proposals.ts';
import {
  LINK_TYPES,
  OBJECT_TYPES,
  titleOf,
} from '../../../../api/src/contexts/ontology/domain/catalog.ts';
import {
  findMention,
  suggestedLink,
} from '../../../../api/src/contexts/ontology/domain/mentions.ts';
import { summarize } from '../../../../api/src/contexts/ontology/application/ontology-service.ts';

const OUT = fileURLToPath(new URL('./fixtures.json', import.meta.url));

/** mulberry32: a small deterministic generator, so the fixture never changes between runs. */
const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const next = random(20261103);
const pick = (list) => list[Math.floor(next() * list.length)];
const chance = (p) => next() < p;

const TEXTS = [
  'Comunidad San Pedro',
  'comunidad  san pedro',
  'Frente de Defensa del Valle',
  'Junta de usuarios',
  'Municipalidad Distrital',
  'ÁLVARO GÓMEZ',
  'alvaro gomez',
  'José Pérez',
  'Asamblea comunal',
  'Corte de agua en el caserío',
  'Bloqueo de vía por el pozo; participa Comunidad San Pedro y la Junta de usuarios',
  'Piden cisternas para el caserío Norte',
  'Reunión con la Municipalidad Distrital sobre el canon',
  'ßeta Straße',
  'İzmir',
  'ΟΔΟΣ ΣΟΦΙΑΣ',
  '😀 tema con emoji',
  'Acta 2026-10',
  '12345',
  '12-34 56',
  'N/A',
  'Sí',
  '   ',
  '',
  'Café del pueblo',
  'Café del pueblo',
  'línea con espacios\tvarios\n',
  'texto﻿ con BOM',
  'x'.repeat(130) + '😀😀😀😀😀😀😀😀😀😀😀😀',
  'y'.repeat(138) + '😀 y sigue',
  'z'.repeat(170),
  `${'w'.repeat(50)} Comunidad San Pedro ${'v'.repeat(80)}`,
  'Comunidad San Pedros',
  'la comunidad san pedro bloqueó',
  'Comunidad\nSan   Pedro',
  'Ana-María Ruiz',
  'ana maria ruiz',
];
const STATES = [
  'Abierta',
  'Cerrada',
  'cumplido',
  'En curso',
  'RESUELTA',
  'Atendido',
  '',
  'Pendiente',
  'ſuperado',
  'Archivado',
];
const LEVELS = [
  'Alta',
  'ALTO',
  'Crítica',
  'critico',
  'Urgente',
  'grave',
  'Roja',
  'Baja',
  'Media',
  'Naranja',
  '',
  'K',
];
const POSITIONS = [
  'En contra',
  'Oposición',
  'opuesto',
  'Rechazo',
  'hostil',
  'A favor',
  'Neutral',
  '',
];
const DATES = [
  '2026-10-01',
  '2026-10-12',
  '2026-10-11',
  '2026-09-30T10:00:00Z',
  '2025-01-15',
  '01/10/2026',
  '',
  '2026-13-45',
  '2026-10-1',
];

const value = () => {
  const r = next();
  if (r < 0.06) return Math.floor(next() * 200) - 50;
  if (r < 0.1) return pick([10.5, 1e21, 1.5e-7, 0.1, -0, 2.5]);
  if (r < 0.12) return pick([true, false]);
  if (r < 0.14) return null;
  if (r < 0.15) return ['a', 1];
  if (r < 0.16) return { nested: 'x' };
  return pick(TEXTS);
};

/** A payload as jsonb would return it: JSON text, keys possibly integer-like. */
const payloadFor = (type) => {
  const entries = [];
  const fields = [
    type.titleField,
    ...type.summaryFields,
    ...(type.dateField ? [type.dateField] : []),
  ];
  for (const field of fields) {
    if (!chance(0.85)) continue;
    let v = value();
    if (field === 'Estado') v = pick(STATES);
    if (field === 'Nivel_Preliminar' || field === 'Prioridad') v = pick(LEVELS);
    if (field === 'Posicion_Proyecto') v = pick(POSITIONS);
    if (field === type.dateField || field === 'Plazo') v = pick(DATES);
    entries.push([field, v]);
  }
  for (const extra of ['Notas', '10', '2', 'Descripcion_Extra', '01', '4294967295', '4294967294']) {
    if (chance(0.15)) entries.push([extra, value()]);
  }
  // Shuffle, so key order is not the catalog's.
  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }
  const parts = entries.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`);
  return `{${parts.join(',')}}`;
};

const MARKINGS = ['publico', 'interno', 'restringido'];
let serial = 0;
const recordOf = (type) => {
  serial += 1;
  const id = chance(0.1) ? pick(['A-1', 'a-1', 'Á-2', 'B-10', 'B-2', 'ñ-3', 'z-0']) : `R-${serial}`;
  return {
    slug: type.slug,
    module: type.module,
    id,
    payloadText: payloadFor(type),
    marking: pick(MARKINGS),
  };
};
const subjectOf = (record) => {
  const type = OBJECT_TYPES.find((t) => t.slug === record.slug);
  return summarize(type, {
    module: record.module,
    id: record.id,
    payload: JSON.parse(record.payloadText),
    marking: record.marking,
  });
};

const briefings = [];
const FOLLOW_UP = OBJECT_TYPES.filter((t) => t.slug === 'alertas' || t.slug === 'demandas');
for (let i = 0; i < 60; i++) {
  const type =
    i < OBJECT_TYPES.length ? OBJECT_TYPES[i] : pick(chance(0.5) ? FOLLOW_UP : OBJECT_TYPES);
  const subject = recordOf(type);
  const count = i % 7 === 0 ? 0 : Math.floor(next() * 11);
  const connections = [];
  for (let c = 0; c < count; c++) {
    const reuse = connections.length && chance(0.15);
    const other = reuse ? pick(connections).other : recordOf(pick(OBJECT_TYPES));
    const link = pick(LINK_TYPES);
    connections.push({
      linkType: link.id,
      label: chance(0.5) ? link.label : link.inverseLabel,
      inferred: chance(0.4),
      other,
    });
  }
  const today = pick(['2026-10-12', '2026-10-01', '2027-01-01']);
  const subjectSummary = subjectOf(subject);
  const conns = connections.map((c) => ({ ...c, other: subjectOf(c.other) }));
  const briefing = buildBriefing(subjectSummary, conns, today);
  briefings.push({
    subject,
    connections,
    today,
    expected: {
      subject: briefing.subject,
      sources: briefing.sources,
      sections: briefing.sections,
      followUps: followUpProposals(subjectSummary, conns, today),
    },
  });
}

const mentions = [];
for (let i = 0; i < 160; i++) {
  const self = recordOf(pick(OBJECT_TYPES));
  const other = recordOf(pick(OBJECT_TYPES));
  const title = chance(0.2)
    ? pick(TEXTS)
    : titleOf(
        OBJECT_TYPES.find((t) => t.slug === other.slug),
        other.id,
        JSON.parse(other.payloadText),
      );
  if (chance(0.5)) {
    const around = pick([
      `${'p'.repeat(70)} `,
      'Se reunió con ',
      'Según ',
      '',
      'Informe: la ',
      '(',
      'x',
    ]);
    const after = pick([` ${'q'.repeat(70)}`, ' ayer.', '', ')', 'x', ' y otros', ', ', '-2']);
    // jsonb holds well-formed text only: PostgreSQL refuses a lone surrogate.
    const inner = self.payloadText.slice(1, -1);
    self.payloadText = `{${inner}${inner ? ',' : ''}"Notas":${JSON.stringify((around + title.toUpperCase() + after).toWellFormed())}}`;
  }
  const payload = JSON.parse(self.payloadText);
  const fields = Object.fromEntries(
    Object.entries(payload).flatMap(([field, v]) =>
      typeof v === 'string' && v.trim() ? [[field, v]] : [],
    ),
  );
  const found = findMention(fields, title);
  const suggested = suggestedLink(
    { slug: self.slug, id: self.id },
    { slug: other.slug, id: other.id },
  );
  const selfSummary = subjectOf(self);
  const otherSummary = subjectOf(other);
  const holder = chance(0.5) ? 'self' : 'other';
  const proposal = found
    ? mentionProposal(selfSummary, {
        ...suggested,
        other: otherSummary,
        label: LINK_TYPES.find((t) => t.id === suggested.linkType)?.label ?? suggested.linkType,
        holder,
        field: found.field,
        excerpt: found.excerpt,
      })
    : null;
  mentions.push({ self, other, title, holder, expected: { found, suggested, proposal } });
}

const COLLATE = [
  'Actor',
  'Acción',
  'Alerta',
  'Compromiso',
  'Contacto',
  'Demanda',
  'Diálogo',
  'Evaluación AARC',
  'Evento',
  'Fuente',
  'Hecho compartido',
  'Interés',
  'Lección territorial',
  'Narrativa',
  'Oportunidad',
  'Caso del buzón',
  'participa en',
  'tiene como participante a',
  'es atendida por',
  'está en conflicto con',
  'es aliado de',
  'está relacionado con',
  'se sustenta en',
  'sustenta',
  'R-1',
  'R-10',
  'R-2',
  'a-1',
  'A-1',
  'Á-2',
  'B-10',
  'B-2',
  'ñ-3',
  'n-3',
  'z-0',
  '',
  '2026-10-01',
  '2026-09-30T10:00:00Z',
  '2026-10-1',
  '01/10/2026',
  'PARITY-AN-1',
  'PARITY-AN-10',
  'PARITY-AN-2',
  'PARITY AN',
  'PARITY_AN',
  'parity-an-1',
];
const collate = [];
for (const a of COLLATE)
  for (const b of COLLATE) collate.push([a, b, Math.sign(a.localeCompare(b))]);

const fixture = { briefings, mentions, collate };
const prettier = await resolveConfig(OUT);
const text = await format(JSON.stringify(fixture), {
  ...prettier,
  filepath: OUT,
});

if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('fixtures.json drifted from the TypeScript domain; rerun without --check');
    process.exit(1);
  }
} else {
  writeFileSync(OUT, text);
}
