import type { Narrator } from '../../src/contexts/analyst/application/index.ts';
import type { EmbeddingProvider } from '../../src/contexts/intelligence/application/index.ts';
import { createTestApp } from '../support/test-app.ts';

// Response bodies are inspected loosely; their shapes are covered by the contracts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;

/** Synthetic people and contact data that must never leave SIPGES in clear. */
export const SECRETS = {
  person: 'Marcos Villanueva Prado',
  complainant: 'Rosa Elena Tapia',
  email: 'marcos.villanueva@example.org',
  phone: '987654321',
  dni: '45678912',
  union: 'sindicato minero',
  stance: 'En contra',
  health: 'diabetes',
} as const;

/** What a caller must never find in anything that leaves: names (any case/accents) and data. */
export const FORBIDDEN = [
  'comunidad campesina',
  'algarrobos',
  'marcos villanueva',
  'villanueva prado',
  'rosa elena',
  'tapia',
  SECRETS.email,
  '987654321',
  '987 654 321',
  SECRETS.dni,
  SECRETS.union,
  'en contra',
  SECRETS.health,
];

export const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export const leaks = (text: string) => FORBIDDEN.filter((needle) => fold(text).includes(needle));

export const PSEUDONYM = /(Actor|Persona|Org)-[0-9A-F]{6}/g;

type Options = {
  env?: Record<string, string>;
  narrator?: Narrator | null;
  embeddings?: EmbeddingProvider;
};

/** One admin session with a synthetic project holding people, contacts and sensitive fields. */
export const setupPrivacy = async (options: Options = {}) => {
  const t = await createTestApp(options.env ?? {}, {
    ...(options.narrator !== undefined ? { narrator: options.narrator } : {}),
    ...(options.embeddings ? { embeddings: options.embeddings } : {}),
  });
  const admin = await t.login('admin', 'admin-password-123');
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    extra: { cookie?: string; scope?: string } = {},
  ) => {
    const res = await t.request(path, {
      method,
      headers: {
        cookie: extra.cookie ?? admin.cookie,
        // With two projects granted, every call names its project.
        'x-sipges-scope': extra.scope ?? 'SIPGES/PRJ-SECHURA',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Json };
  };
  const key = async (name: string, scope?: string, access = 'read', clearance = 'limited') => {
    const res = await call(
      'POST',
      '/system/integrations/api-keys',
      { name, access, clearance },
      scope ? { scope } : {},
    );
    expectOk(res.status, res.body);
    return res.body as { id: number; token: string };
  };
  let nextId = 1;
  const rpc = async (token: string, method: string, params?: unknown) => {
    const res = await t.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        origin: '',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) }),
    });
    return { status: res.status, body: (await res.json()) as Json };
  };
  const tool = async (token: string, name: string, args: unknown) =>
    (await rpc(token, 'tools/call', { name, arguments: args })).body.result as Json;
  const setSwitch = (enabled: boolean, scope?: string) =>
    call('PUT', '/system/v4/settings', { external_ai: { enabled } }, scope ? { scope } : {});
  const audit = async (scope?: string) =>
    (await call('GET', '/system/audit?limit=200', undefined, scope ? { scope } : {}))
      .body as unknown as Json[];
  const egressRows = async (scope?: string) =>
    (await audit(scope)).filter((row) => row.module === 'IA externa');

  /** The same synthetic dataset in whichever project `scope` names. */
  const seed = async (scope?: string) => {
    const extra = scope ? { scope } : {};
    const post = (module: string, payload: Json) =>
      call('POST', `/api/${module}`, { payload }, extra);
    await post('actores', {
      ID_Actor: 'A-1',
      'Nombre_Actor/Organizacion': 'Comunidad Campesina Los Algarrobos',
      Tipo_Actor: 'Comunidad',
      Territorio: 'Sechura',
      Posicion_Proyecto: SECRETS.stance,
      Interes: `Afiliados al ${SECRETS.union}`,
      Telefono: SECRETS.phone,
    });
    await post('directorio', {
      Nombre: SECRETS.person,
      Cargo: 'Presidente',
      Institucion: 'Comunidad Campesina Los Algarrobos',
      Telefono: SECRETS.phone,
      Territorio: 'Sechura',
    });
    await post('eventos', {
      ID_Evento: 'EV-1',
      Fecha: '2026-10-01',
      Territorio: 'Sechura',
      Actor_Principal: 'Comunidad Campesina Los Algarrobos',
      Descripcion_Hecho: `Asamblea convocada por ${SECRETS.person} (${SECRETS.email}, +51 987 654 321, DNI ${SECRETS.dni}); asistió Comunidad Campesina Los Algarrobos`,
      Observaciones: `Nota privada: ${SECRETS.health}`,
    });
    await post('compromisos', {
      ID_Compromiso: 'C-1',
      Descripcion: 'Entrega de agua potable',
      Responsable: SECRETS.person,
      'Actor/Entidad': 'Comunidad Campesina Los Algarrobos',
      Estado: 'Pendiente',
      Plazo: '2026-09-01',
    });
    await post('buzon', {
      ID_Caso: 'BZ-1',
      Fecha: '2026-10-02',
      Tipo: 'Queja',
      Asunto: 'Queja por ruido',
      Remitente: SECRETS.complainant,
      Contacto: 'rosa.tapia@example.org',
      Descripcion: `${SECRETS.complainant} tiene ${SECRETS.health}`,
    });
    await call(
      'POST',
      '/system/links',
      {
        link_type: 'participa_en',
        source: { module: 'actores', id: 'A-1' },
        target: { module: 'eventos', id: 'EV-1' },
        note: '',
      },
      extra,
    );
  };
  return { ...t, admin, call, key, rpc, tool, setSwitch, audit, egressRows, seed };
};

function expectOk(status: number, body: unknown) {
  if (status !== 200) throw new Error(`unexpected status ${status}: ${JSON.stringify(body)}`);
}
