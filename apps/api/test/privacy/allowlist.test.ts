import { describe, expect, it } from 'vitest';
import { OBJECT_TYPES } from '../../src/contexts/ontology/application/index.ts';
import {
  FIELD_POLICIES,
  NEVER_ALLOWED,
  STORED_MODULES,
  TITLE_FIELDS,
  policyFor,
} from '../../src/contexts/privacy/domain/allowlist.ts';

describe('field allowlists', () => {
  const entries = Object.entries(FIELD_POLICIES).flatMap(([module, fields]) =>
    Object.entries(fields).map(([field, policy]) => ({ module, field, policy })),
  );

  it('declare every ontology module', () => {
    expect(Object.keys(FIELD_POLICIES).sort()).toEqual(OBJECT_TYPES.map((t) => t.slug).sort());
  });

  it('know the stored module name of every slug', () => {
    expect(STORED_MODULES).toEqual(Object.fromEntries(OBJECT_TYPES.map((t) => [t.slug, t.module])));
  });

  it('name the title field of every ontology module', () => {
    expect(TITLE_FIELDS).toEqual(
      Object.fromEntries(OBJECT_TYPES.map((t) => [t.slug, t.titleField])),
    );
  });

  it('justify every allowed field', () => {
    expect(entries.length).toBeGreaterThan(50);
    for (const { module, field, policy } of entries)
      expect(policy.why.length, `${module}.${field}`).toBeGreaterThan(15);
  });

  it('never allow political opinion, ethnicity, health, religion, union, income, biometrics or contact', () => {
    for (const { module, field } of entries)
      expect(NEVER_ALLOWED.test(field), `${module}.${field}`).toBe(false);
    for (const forbidden of [
      ['actores', 'Posicion_Proyecto'],
      ['actores', 'Interes'],
      ['intereses', 'Posicion'],
      ['narrativas', 'Tono'],
      ['directorio', 'Telefono'],
      ['buzon', 'Remitente'],
      ['buzon', 'Contacto'],
    ] as const)
      expect(policyFor(forbidden[0], forbidden[1]), forbidden.join('.')).toBeNull();
  });

  it('allow the title and date field of every ontology module', () => {
    for (const type of OBJECT_TYPES) {
      expect(policyFor(type.slug, type.titleField), `${type.slug} title`).not.toBeNull();
      if (type.dateField)
        expect(policyFor(type.slug, type.dateField), `${type.slug} date`).not.toBeNull();
    }
  });

  it('drop everything of a module that has no allowlist', () => {
    expect(policyFor('usuarios', 'ID_Usuario')).toBeNull();
    expect(policyFor('proyectos', 'Nombre')).toBeNull();
    expect(policyFor('actores', 'Campo_Importado')).toBeNull();
  });

  it('pseudonymise every person or organisation field instead of sending it', () => {
    for (const [module, field] of [
      ['actores', 'Nombre_Actor/Organizacion'],
      ['directorio', 'Nombre'],
      ['compromisos', 'Responsable'],
      ['eventos', 'Actor_Principal'],
    ] as const)
      expect(policyFor(module, field)?.kind, `${module}.${field}`).toBe('name');
  });
});
