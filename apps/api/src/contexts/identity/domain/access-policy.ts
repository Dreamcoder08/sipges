import type { Role } from './user.ts';

export type AccessDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly detail: string };

const ALLOW: AccessDecision = { allowed: true };
const deny = (detail: string): AccessDecision => ({ allowed: false, detail });

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** POST endpoints that only compute and persist nothing (ADR 0008 #3). */
const READ_ONLY_POSTS = new Set([
  '/system/analyze',
  '/system/document-lab/analyze',
  '/system/document-lab/compare',
  '/system/document-lab/report.docx',
  '/system/intelligence/semantic-analyze',
]);

/** Personal account security every role must be able to complete (ADR 0009). */
const SELF_SERVICE_POSTS = new Set(['/system/auth/totp/setup', '/system/auth/totp/enable']);

const COORDINATOR_WRITABLE = ['/system/prevention/', '/system/intelligence/territorial-alerts'];

/** Role gates of app.py:241-251 (behavior contract §2, step 8), evaluated in the same order. */
export const checkRoleAccess = (role: Role, method: string, path: string): AccessDecision => {
  const isAdmin = role === 'admin';
  const isRead = READ_METHODS.has(method);

  if (path.startsWith('/system/auth/accounts') && !isAdmin) {
    return deny('Administración de cuentas restringida');
  }
  const adminOnly =
    path.startsWith('/system/export') ||
    path.startsWith('/system/audit') ||
    path.startsWith('/system/metrics') ||
    // Python gates every method except GET here (app.py:244), unlike the read set used elsewhere.
    (path.startsWith('/system/irsa/config') && method !== 'GET');
  if (adminOnly && !isAdmin) return deny('Requiere rol administrador');
  if ((path.startsWith('/api/usuarios') || path.startsWith('/api/roles')) && !isAdmin) {
    return deny('Acceso administrativo requerido');
  }
  if (path.startsWith('/api/proyectos') && !isRead && !isAdmin) {
    return deny('Solo el administrador puede gestionar proyectos');
  }
  if (!isRead && !READ_ONLY_POSTS.has(path) && !SELF_SERVICE_POSTS.has(path)) {
    if (role === 'consulta') return deny('Rol de consulta: solo lectura');
    if (role === 'coordinador' && !COORDINATOR_WRITABLE.some((prefix) => path.startsWith(prefix))) {
      return deny('Operación restringida para coordinador');
    }
  }
  return ALLOW;
};
