/**
 * Synthetic users and projects for the parity cases, created through the TypeScript API on a
 * fresh database (its admin already holds the default project):
 *   admin    — SIPGES/PRJ-SECHURA and PARITY/PRJ-B, so it must choose a project;
 *   consulta — SIPGES/PRJ-SECHURA only, chosen automatically; read-only role.
 */
import { randomBytes } from 'node:crypto';
import { signIn } from './servers.ts';

export const DEFAULT_SCOPE = 'SIPGES/PRJ-SECHURA';
export const SECOND_SCOPE = 'PARITY/PRJ-B';
export const CONSULTA = 'parity-consulta';

export type Sessions = { readonly admin: string; readonly consulta: string };

const post = async (tsUrl: string, cookie: string, path: string, body: unknown) => {
  const response = await fetch(`${tsUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: tsUrl, cookie },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`seed ${path} failed with ${response.status}: ${await response.text()}`);
  }
};

export const seed = async (
  tsUrl: string,
  admin: { readonly username: string; readonly password: string },
): Promise<Sessions> => {
  const adminCookie = await signIn(tsUrl, admin.username, admin.password);
  const password = `parity-${randomBytes(18).toString('base64url')}`;
  // While the admin holds one project these resolve it automatically.
  await post(tsUrl, adminCookie, '/system/auth/accounts', {
    username: CONSULTA,
    full_name: 'Consulta de paridad',
    password,
    role: 'consulta',
  });
  const [company, project] = DEFAULT_SCOPE.split('/');
  await post(tsUrl, adminCookie, '/system/auth/grants', {
    username: CONSULTA,
    company_id: company,
    project_id: project,
  });
  const [secondCompany, secondProject] = SECOND_SCOPE.split('/');
  await post(tsUrl, adminCookie, '/system/auth/scopes', {
    company_id: secondCompany,
    project_id: secondProject,
    label: 'Proyecto de paridad',
    username: admin.username,
  });
  return { admin: adminCookie, consulta: await signIn(tsUrl, CONSULTA, password) };
};
