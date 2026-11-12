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
  '/system/geography/query',
  '/system/graph/neighbourhood',
]);

/** Personal account security every role must be able to complete (ADR 0009). */
const SELF_SERVICE_POSTS = new Set([
  '/system/auth/totp/setup',
  '/system/auth/totp/enable',
  // Marking one's own notifications as read (ADR 0014).
  '/system/notifications/read',
  // Enabling or disabling one's own device notifications.
  '/system/notifications/push',
  '/system/notifications/push/unsubscribe',
  '/system/notifications/push/test',
  // Signing one's own other devices out (Cuenta).
  '/system/auth/sessions/revoke-others',
]);

const OWN_SESSIONS = '/system/auth/sessions/';

/** Personal writes any role may make: the posts above, and ending one of one's own sessions. */
const isSelfService = (method: string, path: string) =>
  SELF_SERVICE_POSTS.has(path) ||
  (method === 'DELETE' &&
    path.startsWith(OWN_SESSIONS) &&
    path.length > OWN_SESSIONS.length &&
    !path.slice(OWN_SESSIONS.length).includes('/'));

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
    path.startsWith('/system/automations') ||
    path.startsWith('/system/integrations') ||
    // Python gates every method except GET here (app.py:244), unlike the read set used elsewhere.
    (path.startsWith('/system/irsa/config') && method !== 'GET') ||
    // Project settings (colour meanings, thresholds, phase) are a project decision (ADR 0020, 0027).
    (path.startsWith('/system/v4/settings') && !isRead) ||
    // Which media sources the project reads is a project decision too (ADR 0021).
    (path.startsWith('/system/v4/media') && !isRead);
  if (adminOnly && !isAdmin) return deny('Requiere rol administrador');
  if ((path.startsWith('/api/usuarios') || path.startsWith('/api/roles')) && !isAdmin) {
    return deny('Acceso administrativo requerido');
  }
  if (path.startsWith('/api/proyectos') && !isRead && !isAdmin) {
    return deny('Solo el administrador puede gestionar proyectos');
  }
  if (!isRead && !READ_ONLY_POSTS.has(path) && !isSelfService(method, path)) {
    if (role === 'consulta') return deny('Rol de consulta: solo lectura');
    if (role === 'coordinador' && !COORDINATOR_WRITABLE.some((prefix) => path.startsWith(prefix))) {
      return deny('Operación restringida para coordinador');
    }
  }
  return ALLOW;
};

/** Read-only accounts never see records marked 'restringido' (docs/adr/0012). */
export const clearanceFor = (role: Role): 'full' | 'limited' =>
  role === 'consulta' ? 'limited' : 'full';
