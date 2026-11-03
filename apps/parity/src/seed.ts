/**
 * Synthetic users and projects for the parity cases, created through the TypeScript API on a
 * fresh database, whose bootstrap administrator already holds the default project:
 *   admin    — SIPGES/PRJ-SECHURA only (chosen automatically);
 *   consulta — SIPGES/PRJ-SECHURA only; read-only role;
 *   multi    — SIPGES/PRJ-SECHURA and PARITY/PRJ-B (analista), so it must choose a project.
 * Each project also gets a verified territorial alert and preventive action plans (prevention
 * routes): overdue, blocked and cancelled ones in the default project, one in the second, so a
 * read of one project that showed the other's plans would differ.
 */
import { randomBytes } from 'node:crypto';
import { signIn } from './servers.ts';

export const DEFAULT_SCOPE = 'SIPGES/PRJ-SECHURA';
export const SECOND_SCOPE = 'PARITY/PRJ-B';

export type Sessions = Readonly<Record<'admin' | 'consulta' | 'multi', string>>;

const send = async (
  method: 'POST' | 'PATCH',
  tsUrl: string,
  cookie: string,
  path: string,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<Record<string, unknown>> => {
  const response = await fetch(`${tsUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: tsUrl, cookie, ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`seed ${path} failed with ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as Record<string, unknown>;
};

const post = (tsUrl: string, cookie: string, path: string, body: unknown, headers = {}) =>
  send('POST', tsUrl, cookie, path, body, headers);

/** One plan, then each update in order; the plan's alert is created and verified first. */
type Plan = {
  readonly title: string;
  readonly due_date: string;
  readonly updates?: readonly Record<string, unknown>[];
};

/** A territorial alert verified by a person ('En seguimiento'), then its preventive plans. */
const seedPlans = async (
  tsUrl: string,
  cookie: string,
  plans: readonly Plan[],
  headers: Readonly<Record<string, string>> = {},
) => {
  const alert = await post(
    tsUrl,
    cookie,
    '/system/intelligence/territorial-alerts',
    { text: 'Reunión vecinal programada para revisar el horario del mercado.', mode: 'rules' },
    headers,
  );
  const alertId = String(alert.id);
  await send(
    'PATCH',
    tsUrl,
    cookie,
    `/system/intelligence/territorial-alerts/${alertId}`,
    { status: 'En seguimiento', reviewer_note: 'Verificado para la paridad' },
    headers,
  );
  for (const plan of plans) {
    const created = await post(
      tsUrl,
      cookie,
      '/system/prevention/actions',
      {
        alert_id: alertId,
        title: plan.title,
        responsible: 'Equipo de paridad',
        due_date: plan.due_date,
        description: `Plan sintético: ${plan.title}`,
      },
      headers,
    );
    const id = String((created.action as Record<string, unknown>).id);
    for (const update of plan.updates ?? []) {
      await send('PATCH', tsUrl, cookie, `/system/prevention/actions/${id}`, update, headers);
    }
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
  await seedPlans(tsUrl, adminCookie, [
    { title: 'Plan vencido sin avance', due_date: '2020-01-15' },
    {
      title: 'Plan bloqueado por la comunidad',
      due_date: '2099-12-31',
      updates: [
        {
          status: 'En ejecución',
          progress: 40,
          note: 'Primera reunión hecha',
          evidence_url: 'https://example.org/acta',
          blocked_by: 'Comunidad',
          blocked_reason: 'Esperando la asamblea',
        },
      ],
    },
    {
      title: 'Plan bloqueado por la autoridad',
      due_date: '2021-03-01',
      updates: [{ status: 'En ejecución', progress: 15, note: '', blocked_by: 'Autoridad' }],
    },
    {
      title: 'Plan cancelado por duplicado',
      due_date: '2099-06-30',
      updates: [{ status: 'Cancelada', progress: 0, note: 'Duplicado de otro plan' }],
    },
    {
      title: 'Plan en marcha normal',
      due_date: '2099-01-10',
      updates: [{ status: 'En ejecución', progress: 33, note: 'Avance parcial' }],
    },
  ]);
  const session = (name: keyof typeof users) =>
    signIn(tsUrl, users[name].username, passwords[users[name].username] ?? '');
  const multi = await session('multi');
  await seedPlans(tsUrl, multi, [{ title: 'Plan del segundo proyecto', due_date: '2020-02-02' }], {
    'x-sipges-scope': SECOND_SCOPE,
  });
  return { admin: adminCookie, consulta: await session('consulta'), multi };
};
