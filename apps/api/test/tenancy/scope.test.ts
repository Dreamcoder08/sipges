import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCOPE,
  formatScope,
  parseScope,
  resolveScope,
  validateNewTenant,
} from '../../src/contexts/tenancy/domain/scope.ts';

const sechura = { companyId: 'SIPGES', projectId: 'PRJ-SECHURA' };
const norte = { companyId: 'ACME', projectId: 'NORTE' };

describe('scope text', () => {
  it('formats and parses company/project, splitting at the first slash like Python', () => {
    expect(formatScope(norte)).toBe('ACME/NORTE');
    expect(parseScope('ACME/NORTE')).toEqual(norte);
    expect(parseScope('ACME/NORTE/X')).toEqual({ companyId: 'ACME', projectId: 'NORTE/X' });
    expect(parseScope('no-slash')).toBeNull();
  });

  it('keeps the legacy default scope', () => {
    expect(DEFAULT_SCOPE).toEqual(sechura);
  });
});

describe('resolveScope (app.py enforce_auth step 4)', () => {
  const grants = [sechura, norte];

  it('prefers the X-SIPGES-Scope header over the cookie', () => {
    expect(resolveScope({ header: 'ACME/NORTE', cookie: 'SIPGES/PRJ-SECHURA', grants })).toEqual(
      norte,
    );
  });

  it('falls back to the scope cookie', () => {
    expect(resolveScope({ header: undefined, cookie: 'SIPGES/PRJ-SECHURA', grants })).toEqual(
      sechura,
    );
  });

  it('selects the only grant when nothing was requested', () => {
    expect(resolveScope({ header: undefined, cookie: undefined, grants: [norte] })).toEqual(norte);
  });

  it('refuses when nothing was requested and the user has several grants', () => {
    expect(resolveScope({ header: '', cookie: '', grants })).toBeNull();
  });

  it('refuses a requested scope that is not granted', () => {
    expect(resolveScope({ header: 'OTHER/X', cookie: undefined, grants })).toBeNull();
    expect(resolveScope({ header: undefined, cookie: 'OTHER/X', grants: [norte] })).toBeNull();
  });

  it('refuses everything for a user without grants', () => {
    expect(resolveScope({ header: undefined, cookie: undefined, grants: [] })).toBeNull();
  });
});

describe('validateNewTenant (app.py:355-361)', () => {
  const input = { companyId: 'ACME', projectId: 'NORTE', label: 'Proyecto Norte', username: 'ana' };

  it('accepts valid IDs and truncates the label to 120 characters', () => {
    expect(validateNewTenant({ ...input, label: 'x'.repeat(200) })).toEqual({
      ok: true,
      value: { ...input, label: 'x'.repeat(120) },
    });
  });

  it.each(['A', 'a'.repeat(65), 'with space', 'acme/x', 'ñandu'])('rejects ID %j', (id) => {
    expect(validateNewTenant({ ...input, companyId: id })).toEqual({
      ok: false,
      error: 'invalid_ids',
    });
    expect(validateNewTenant({ ...input, projectId: id })).toEqual({
      ok: false,
      error: 'invalid_ids',
    });
  });

  it('reserves the legacy default scope', () => {
    expect(validateNewTenant({ ...input, companyId: 'SIPGES', projectId: 'PRJ-SECHURA' })).toEqual({
      ok: false,
      error: 'reserved',
    });
  });
});
