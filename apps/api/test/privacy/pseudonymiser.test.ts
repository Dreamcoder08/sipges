import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type KnownName,
  createPseudonymiser,
} from '../../src/contexts/privacy/domain/pseudonyms.ts';
import { scrubPatterns } from '../../src/contexts/privacy/domain/scrub.ts';

const macFor = (key: string) => (message: string) =>
  createHmac('sha256', key).update(message).digest('hex');

const NAMES: KnownName[] = [
  { kind: 'Actor', name: 'Comunidad Campesina Los Algarrobos' },
  { kind: 'Persona', name: 'José Pérez Núñez' },
  { kind: 'Org', name: 'Municipalidad de Sechura' },
];

describe('pseudonyms', () => {
  const p = createPseudonymiser({ mac: macFor('k1'), names: NAMES });

  it('are short, typed and stable for the same input', () => {
    const first = p.pseudonym('Actor', 'Comunidad Campesina Los Algarrobos');
    expect(first).toMatch(/^Actor-[0-9A-F]{6}$/);
    expect(p.pseudonym('Actor', 'Comunidad Campesina Los Algarrobos')).toBe(first);
    expect(p.pseudonym('Persona', 'José Pérez Núñez')).toMatch(/^Persona-[0-9A-F]{6}$/);
    expect(p.pseudonym('Org', 'Municipalidad de Sechura')).toMatch(/^Org-[0-9A-F]{6}$/);
  });

  it('ignore case, accents and spacing in the input', () => {
    expect(p.pseudonym('Persona', '  JOSE   perez nunez ')).toBe(
      p.pseudonym('Persona', 'José Pérez Núñez'),
    );
  });

  it('differ between keys (projects) and between names', () => {
    const other = createPseudonymiser({ mac: macFor('k2'), names: NAMES });
    expect(other.pseudonym('Actor', 'X')).not.toBe(p.pseudonym('Actor', 'X'));
    expect(p.pseudonym('Actor', 'X')).not.toBe(p.pseudonym('Actor', 'Y'));
  });

  it('never contain the input or the key', () => {
    const value = p.pseudonym('Persona', 'José Pérez Núñez');
    expect(value.toLowerCase()).not.toContain('jose');
    expect(value).not.toContain('k1');
  });
});

describe('known names in free text', () => {
  const p = createPseudonymiser({ mac: macFor('k1'), names: NAMES });
  const person = p.pseudonym('Persona', 'José Pérez Núñez');

  it('are replaced whatever the case or accents, keeping the rest', () => {
    expect(p.scrub('Habló jose PEREZ nunez ayer; luego JOSÉ PÉREZ NÚÑEZ.')).toBe(
      `Habló ${person} ayer; luego ${person}.`,
    );
  });

  it('only match whole words and prefer the longest name', () => {
    const q = createPseudonymiser({
      mac: macFor('k1'),
      names: [
        { kind: 'Org', name: 'Sechura' },
        { kind: 'Org', name: 'Municipalidad de Sechura' },
      ],
    });
    expect(q.scrub('Municipalidad de Sechura y Sechuranos')).toBe(
      `${q.pseudonym('Org', 'Municipalidad de Sechura')} y Sechuranos`,
    );
  });

  it('resolve a name found under two kinds to one pseudonym (actor first)', () => {
    const q = createPseudonymiser({
      mac: macFor('k1'),
      names: [
        { kind: 'Org', name: 'Comunidad Norte' },
        { kind: 'Actor', name: 'Comunidad Norte' },
      ],
    });
    expect(q.scrub('Comunidad Norte')).toBe(q.pseudonym('Actor', 'Comunidad Norte'));
    expect(q.kindOf('comunidad norte')).toBe('Actor');
  });

  it('also scrub contact data', () => {
    expect(p.scrub('Escribir a a.b@x.org')).toBe('Escribir a [correo]');
  });
});

describe('contact data', () => {
  it.each([
    ['correo a.b+c@mail.example.org hoy', 'correo [correo] hoy'],
    ['llamar al 987654321', 'llamar al [teléfono]'],
    ['llamar al 987 654 321 ya', 'llamar al [teléfono] ya'],
    ['cel +51 987-654-321.', 'cel [teléfono].'],
    ['cel 0051987654321', 'cel [teléfono]'],
    ['fijo (01) 234-5678', 'fijo [teléfono]'],
    ['fijo 073-123456', 'fijo [teléfono]'],
    ['DNI 45678912', 'DNI [DNI]'],
    ['D.N.I. N° 45678912', 'D.N.I. N° [DNI]'],
    ['dni: 45678912.', 'dni: [DNI].'],
    ['documento de identidad 45678912', 'documento de identidad [DNI]'],
    ['RUC 20123456789', 'RUC [RUC]'],
  ])('replaces in %j', (input, expected) => {
    expect(scrubPatterns(input)).toBe(expected);
  });

  it.each([
    'presupuesto de 45678912 soles',
    'fecha 2026-10-12 y 12 de octubre',
    'avance 85% en 3 meses',
    'coordenadas -5.5571 -80.8222',
  ])('leaves %j untouched', (input) => {
    expect(scrubPatterns(input)).toBe(input);
  });
});

describe('text cut by the ontology (…)', () => {
  const p = createPseudonymiser({
    mac: macFor('k1'),
    names: [
      { kind: 'Persona', name: 'Marcos Villanueva Prado' },
      { kind: 'Actor', name: 'Comunidad Campesina Los Algarrobos' },
    ],
  });
  const person = p.pseudonym('Persona', 'Marcos Villanueva Prado');
  const actor = p.pseudonym('Actor', 'Comunidad Campesina Los Algarrobos');

  it('replaces half a name at the end, even when the cut left a space', () => {
    expect(p.scrub('Habló Marcos Villan…')).toBe(`Habló ${person}…`);
    expect(p.scrub('Asistió Comunidad Campesina …')).toBe(`Asistió ${actor} …`);
    expect(p.scrub('Habló Marcos…')).toBe(`Habló ${person}…`);
  });

  it('replaces half a name at the start', () => {
    expect(p.scrub('…eva Prado dijo que sí')).toBe(`…${person} dijo que sí`);
    expect(p.scrub('… Prado habló')).toBe(`… ${person} habló`);
  });

  it('leaves ordinary words at the edge alone', () => {
    expect(p.scrub('La asamblea terminó con un acuer…')).toBe('La asamblea terminó con un acuer…');
    expect(p.scrub('…dad de agua')).toBe('…dad de agua');
  });

  it('clears half an email and digits touching the mark', () => {
    expect(p.scrub('escribir a juan.perez@exam…')).toBe('escribir a [correo]…');
    expect(p.scrub('llamar al 98765…')).toBe('llamar al [teléfono]…');
    expect(p.scrub('…4321 es el número')).toBe('…4321 es el número');
    expect(p.scrub('…654321 es el número')).toBe('…[teléfono] es el número');
  });
});
