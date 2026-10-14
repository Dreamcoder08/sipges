import type { Role } from '@mascli/contracts';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';

/**
 * Synthetic API double. Each test starts signed out with one project; handlers mirror the
 * contracts in packages/contracts.
 */
export type ApiState = {
  me: { username: string; full_name: string; role: Role } | null;
  scope: string | null;
  scopes: { company_id: string; project_id: string; label: string }[];
  otpRequired: boolean;
  requests: string[];
};

export const api: ApiState = {
  me: null,
  scope: null,
  scopes: [],
  otpRequired: false,
  requests: [],
};

export const resetApi = (overrides: Partial<ApiState> = {}) => {
  Object.assign(api, {
    me: null,
    scope: 'DEMO/PRJ-DEMO',
    scopes: [{ company_id: 'DEMO', project_id: 'PRJ-DEMO', label: 'Proyecto Demo' }],
    otpRequired: false,
    requests: [],
    ...overrides,
  });
};

const unauthorized = () =>
  HttpResponse.json({ detail: 'Inicie sesión para acceder a MASCLI' }, { status: 401 });

const signedIn = <T>(respond: () => T) => (api.me ? respond() : unauthorized());

const SYNTHETIC_ALERTS = [
  { _id: 'AL-1', Estado: 'Abierta', Nivel_Preliminar: 'Alta', Proyecto_ID: 'PRJ-DEMO' },
  { _id: 'AL-2', Estado: 'Cerrada', Nivel: 'Rojo', Proyecto_ID: 'PRJ-DEMO' },
  { _id: 'AL-3', Estado: 'Abierta', Nivel: 'Rojo', Proyecto_ID: 'OTRO' },
];
const SYNTHETIC_EVENTS = [
  { _id: 'EV-1', Dimension_Principal: 'E - Ambiental', Proyecto_ID: 'PRJ-DEMO' },
  { _id: 'EV-2', Dimension_Principal: 'g', Proyecto_ID: 'PRJ-DEMO' },
];

export const handlers = [
  http.get('/system/auth/providers', () => HttpResponse.json({ google: false })),
  http.get('/system/auth/me', () => HttpResponse.json(api.me ? { ...api.me, active: 1 } : null)),
  http.post('/login', async ({ request }) => {
    const form = new URLSearchParams(await request.text());
    if (form.get('password') !== 'synthetic-pass-123') {
      return HttpResponse.json({ detail: 'Credenciales inválidas' }, { status: 401 });
    }
    if (api.otpRequired && form.get('otp') !== '123456') {
      return HttpResponse.json({ detail: 'Código de autenticación inválido' }, { status: 401 });
    }
    api.me = {
      username: form.get('username') ?? '',
      full_name: 'Persona Sintética',
      role: 'admin',
    };
    return HttpResponse.json({ ok: true, name: api.me.full_name, role: api.me.role });
  }),
  http.post('/logout', () => {
    api.me = null;
    return HttpResponse.json({ ok: true });
  }),
  http.get('/system/auth/scopes', () => signedIn(() => HttpResponse.json(api.scopes))),
  http.get('/system/auth/current-scope', () =>
    signedIn(() => {
      if (!api.scope) {
        return HttpResponse.json(
          {
            detail: 'Seleccione un proyecto autorizado',
            projects: api.scopes.map((s) => s.project_id),
          },
          { status: 403 },
        );
      }
      const [company_id = '', project_id = ''] = api.scope.split('/');
      return HttpResponse.json({ company_id, project_id, scope: api.scope });
    }),
  ),
  http.post('/select-project', async ({ request }) => {
    const scope = new URLSearchParams(await request.text()).get('scope');
    if (!api.scopes.some((s) => `${s.company_id}/${s.project_id}` === scope)) {
      return HttpResponse.json({ detail: 'Proyecto no autorizado' }, { status: 403 });
    }
    api.scope = scope;
    return new HttpResponse(null, { status: 303, headers: { location: '/' } });
  }),
  http.get('/api/dashboard', () =>
    signedIn(() =>
      HttpResponse.json({
        eventos: 2,
        actores: 7,
        demandas_abiertas: 3,
        alertas_activas: 1,
        directorio: 4,
        priorizados: 5,
        niveles: { Alta: 1, Rojo: 2 },
      }),
    ),
  ),
  http.get('/system/notifications', () =>
    signedIn(() => HttpResponse.json({ unread: 0, items: [] })),
  ),
  http.get('/system/briefing/proposals', () => signedIn(() => HttpResponse.json([]))),
  http.get('/system/notifications/push', () =>
    signedIn(() => HttpResponse.json({ enabled: false, public_key: null })),
  ),
  http.get('/api/alertas', () => signedIn(() => HttpResponse.json(SYNTHETIC_ALERTS))),
  http.get('/api/eventos', () => signedIn(() => HttpResponse.json(SYNTHETIC_EVENTS))),
  http.get('/system/irsa', () =>
    signedIn(() =>
      HttpResponse.json({
        irsa: 42.25,
        level: 'Amarillo',
        scores: { G: 10, A: 20, D: 30, N: 40, E: 50, I: 60 },
        drivers: [
          {
            dimension: 'E',
            dimension_label: 'Ambiental-territorial',
            id: 'E1',
            label: 'Conflicto por agua',
            points: 12.4,
          },
        ],
        config_version: '0.4-indicators',
      }),
    ),
  ),
  http.get('/system/model-status', () =>
    signedIn(() =>
      HttpResponse.json({
        version: 'Motor sintético',
        content_validation: 'Pendiente',
        release_rule: 'Regla sintética',
      }),
    ),
  ),
];

export const server = setupServer(...handlers);

// Observe requests even when individual tests override response handlers.
server.events.on('request:start', ({ request }) => {
  api.requests.push(`${request.method} ${new URL(request.url).pathname}`);
});
