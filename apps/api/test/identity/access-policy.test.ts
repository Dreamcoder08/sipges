import { describe, expect, it } from 'vitest';
import { checkRoleAccess } from '../../src/contexts/identity/domain/access-policy.ts';

// Messages and rules from app.py:241-251 (behavior contract §2, step 8) with ADR 0008 #3.
describe('checkRoleAccess', () => {
  const denied = (detail: string) => ({ allowed: false, detail });
  const allowed = { allowed: true };

  it.each([
    ['analista', 'GET', '/system/auth/accounts', denied('Administración de cuentas restringida')],
    ['admin', 'POST', '/system/auth/accounts', allowed],
    ['analista', 'GET', '/system/export', denied('Requiere rol administrador')],
    ['analista', 'GET', '/system/audit', denied('Requiere rol administrador')],
    ['analista', 'POST', '/system/irsa/config', denied('Requiere rol administrador')],
    ['analista', 'GET', '/system/irsa/config', allowed],
    ['analista', 'GET', '/api/usuarios', denied('Acceso administrativo requerido')],
    ['coordinador', 'GET', '/api/roles', denied('Acceso administrativo requerido')],
    [
      'analista',
      'POST',
      '/api/proyectos',
      denied('Solo el administrador puede gestionar proyectos'),
    ],
    ['analista', 'GET', '/api/proyectos', allowed],
    ['consulta', 'POST', '/api/eventos', denied('Rol de consulta: solo lectura')],
    ['consulta', 'GET', '/api/eventos', allowed],
    ['coordinador', 'POST', '/api/eventos', denied('Operación restringida para coordinador')],
    ['coordinador', 'POST', '/system/prevention/actions', allowed],
    ['coordinador', 'PATCH', '/system/intelligence/territorial-alerts/7', allowed],
    ['analista', 'POST', '/system/auth/totp/setup', allowed],
    ['consulta', 'POST', '/system/auth/totp/setup', allowed],
    ['consulta', 'POST', '/system/auth/totp/enable', allowed],
    ['coordinador', 'POST', '/system/auth/totp/setup', allowed],
  ] as const)('%s %s %s', (role, method, path, expected) => {
    expect(checkRoleAccess(role, method, path)).toEqual(expected);
  });

  it.each([
    '/system/analyze',
    '/system/document-lab/analyze',
    '/system/document-lab/compare',
    '/system/document-lab/report.docx',
    '/system/intelligence/semantic-analyze',
  ])('ADR 0008 #3: read-only POST %s is open to every role', (path) => {
    expect(checkRoleAccess('consulta', 'POST', path)).toEqual(allowed);
    expect(checkRoleAccess('coordinador', 'POST', path)).toEqual(allowed);
  });
});
