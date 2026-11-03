/**
 * Synthetic users and projects for the parity cases, created through the TypeScript API on a
 * fresh database, whose bootstrap administrator already holds the default project:
 *   admin    — SIPGES/PRJ-SECHURA only (chosen automatically);
 *   consulta — SIPGES/PRJ-SECHURA only; read-only role;
 *   multi    — SIPGES/PRJ-SECHURA and PARITY/PRJ-B (analista), so it must choose a project.
 * Both projects also get situations records, and the default one saved settings (seed-situations.ts).
 */
import { randomBytes } from 'node:crypto';
import { seedSituations } from './seed-situations.ts';
import { signIn } from './servers.ts';

export const DEFAULT_SCOPE = 'SIPGES/PRJ-SECHURA';
export const SECOND_SCOPE = 'PARITY/PRJ-B';

export type Sessions = Readonly<Record<'admin' | 'consulta' | 'multi', string>>;

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

const scope = (value: string) => {
  const [company_id, project_id] = value.split('/');
  return { company_id, project_id };
};

export const seed = async (
  tsUrl: string,
  admin: { readonly username: string; readonly password: string },
): Promise<Sessions> => {
  const adminCookie = await signIn(tsUrl, admin.username, admin.password);
  const users = {
    consulta: { username: 'parity-consulta', role: 'consulta' },
    multi: { username: 'parity-multi', role: 'analista' },
  } as const;
  const passwords: Record<string, string> = {};
  for (const { username, role } of Object.values(users)) {
    passwords[username] = `parity-${randomBytes(18).toString('base64url')}`;
    await post(tsUrl, adminCookie, '/system/auth/accounts', {
      username,
      full_name: `Paridad ${role}`,
      password: passwords[username],
      role,
    });
    await post(tsUrl, adminCookie, '/system/auth/grants', { username, ...scope(DEFAULT_SCOPE) });
  }
  // Creating the tenant grants it to multi only; the administrator keeps one project.
  await post(tsUrl, adminCookie, '/system/auth/scopes', {
    ...scope(SECOND_SCOPE),
    label: 'Proyecto de paridad',
    username: users.multi.username,
  });
  const session = (name: keyof typeof users) =>
    signIn(tsUrl, users[name].username, passwords[users[name].username] ?? '');
  const multi = await session('multi');
  await seedSituations(tsUrl, adminCookie, multi, SECOND_SCOPE);
  return { admin: adminCookie, consulta: await session('consulta'), multi };
};
