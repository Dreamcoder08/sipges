import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPseudonymiser } from '../../src/contexts/privacy/domain/pseudonyms.ts';
import { sanitiseRecords } from '../../src/contexts/privacy/domain/sanitise.ts';

const pseudonymiser = createPseudonymiser({
  mac: (message) => createHmac('sha256', 'k').update(message).digest('hex'),
  names: [
    { kind: 'Actor', name: 'Comunidad Norte' },
    { kind: 'Persona', name: 'Marcos Villanueva' },
  ],
});

describe('sanitiseRecords', () => {
  const run = sanitiseRecords(pseudonymiser, [
    {
      module: 'actores',
      id: 'A-1',
      title: 'Comunidad Norte',
      marking: 'interno',
      fields: {
        'Nombre_Actor/Organizacion': 'Comunidad Norte',
        Tipo_Actor: 'Comunidad',
        Posicion_Proyecto: 'En contra',
        Telefono: '987654321',
        Territorio: 'Sechura',
        Vacio: '',
      },
    },
    {
      module: 'eventos',
      id: 'EV-1',
      marking: 'interno',
      fields: {
        Descripcion_Hecho: 'Habló Marcos Villanueva (m@x.org)',
        Fecha: '2026-10-01',
        Observaciones: 'privado',
      },
    },
  ]);

  it('keeps allowed fields, pseudonymises names and scrubs free text', () => {
    const [actor, event] = run.records;
    expect(actor?.title).toBe(pseudonymiser.pseudonym('Actor', 'Comunidad Norte'));
    expect(actor?.fields).toEqual({
      'Nombre_Actor/Organizacion': pseudonymiser.pseudonym('Actor', 'Comunidad Norte'),
      Tipo_Actor: 'Comunidad',
      Territorio: 'Sechura',
    });
    expect(event?.fields).toEqual({
      Descripcion_Hecho: `Habló ${pseudonymiser.pseudonym('Persona', 'Marcos Villanueva')} ([correo])`,
      Fecha: '2026-10-01',
    });
  });

  it('reports ids, fields sent and fields dropped, never values', () => {
    expect(run.report).toEqual({
      records: ['actores/A-1', 'eventos/EV-1'],
      sent: 5,
      dropped: 3,
      withheld: [],
      droppedFields: ['Observaciones', 'Posicion_Proyecto', 'Telefono'],
    });
    expect(JSON.stringify(run.report)).not.toContain('987654321');
  });

  it('pseudonymises a name that no directory knew', () => {
    const [record] = sanitiseRecords(pseudonymiser, [
      {
        module: 'compromisos',
        id: 'C-1',
        marking: 'publico',
        fields: { Responsable: 'Persona Desconocida' },
      },
    ]).records;
    expect(record?.fields.Responsable).toMatch(/^Persona-[0-9A-F]{6}$/);
  });

  it('splits lists of names and pseudonymises every item', () => {
    const [record] = sanitiseRecords(pseudonymiser, [
      {
        module: 'dialogos',
        id: 'D-1',
        marking: 'interno',
        fields: { Participantes: 'Comunidad Norte, Ana Gómez y Luis Ríos' },
      },
    ]).records;
    const parts = String(record?.fields.Participantes).split(', ');
    expect(parts).toHaveLength(3);
    for (const part of parts) expect(part).toMatch(/^(Actor|Persona|Org)-[0-9A-F]{6}$/);
    expect(parts[0]).toBe(pseudonymiser.pseudonym('Actor', 'Comunidad Norte'));
  });

  it('sends nothing for a module without allowlist', () => {
    const out = sanitiseRecords(pseudonymiser, [
      {
        module: 'usuarios',
        id: 'U-1',
        marking: 'interno',
        fields: { Nombre: 'Ana', Correo: 'ana@x.org' },
      },
    ]);
    expect(out.records[0]?.fields).toEqual({});
    expect(out.report.dropped).toBe(2);
  });
});

describe('sanitiseRecords and markings', () => {
  const rows = (marking: string | null) =>
    sanitiseRecords(pseudonymiser, [
      {
        module: 'eventos',
        id: 'EV-7',
        marking,
        fields: { Fecha: '2026-10-01', Territorio: 'Sechura' },
      },
    ]);

  it.each(['restringido', 'desconocido', null])('withholds a record marked %s', (marking) => {
    const out = rows(marking);
    expect(out.records[0]).toMatchObject({ withheld: true, title: null, fields: {} });
    expect(out.report).toMatchObject({ withheld: ['eventos/EV-7'], sent: 0, dropped: 2 });
  });

  it.each(['publico', 'interno'])('releases a record marked %s', (marking) => {
    const out = rows(marking);
    expect(out.records[0]?.withheld).toBe(false);
    expect(out.report).toMatchObject({ withheld: [], sent: 2, dropped: 0 });
  });
});
