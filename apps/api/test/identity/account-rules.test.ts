import { describe, expect, it } from 'vitest';
import { validateNewAccount } from '../../src/contexts/identity/domain/user.ts';

const base = {
  username: 'ana.perez',
  fullName: 'Ana Pérez',
  password: 'twelve-chars',
  role: 'analista',
};

describe('validateNewAccount (app.py:298-302)', () => {
  it('accepts a valid account and truncates the full name to 120 characters', () => {
    const result = validateNewAccount({ ...base, fullName: 'x'.repeat(200) });
    expect(result).toEqual({ ok: true, value: { ...base, fullName: 'x'.repeat(120) } });
  });

  it.each(['ab', 'Ana', 'a'.repeat(41), 'ana perez', 'ana@x'])(
    'rejects username %j',
    (username) => {
      expect(validateNewAccount({ ...base, username })).toEqual({
        ok: false,
        error: 'Usuario inválido',
      });
    },
  );

  it('rejects unknown roles', () => {
    expect(validateNewAccount({ ...base, role: 'root' })).toEqual({
      ok: false,
      error: 'Rol no válido',
    });
  });

  it('enforces 12 to 256 characters for passwords', () => {
    expect(validateNewAccount({ ...base, password: 'x'.repeat(11) })).toEqual({
      ok: false,
      error: 'Contraseña demasiado corta: mínimo 12 caracteres',
    });
    expect(validateNewAccount({ ...base, password: 'x'.repeat(257) })).toEqual({
      ok: false,
      error: 'Contraseña demasiado larga: máximo 256 caracteres',
    });
    expect(validateNewAccount({ ...base, password: 'x'.repeat(256) }).ok).toBe(true);
  });
});
