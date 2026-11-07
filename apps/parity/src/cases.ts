/**
 * The parity route list (docs/adr/0032 §6): every route the Go API serves gets at least one case
 * here, and a route switches to Go only while its cases pass. Later phases add entries; the
 * runner does not change.
 */

import { CONTEXT_CASES } from './contexts/index.ts';
import type { ParityCase } from './types.ts';

export type { Method, ParityCase } from './types.ts';

const UNKNOWN_TOKEN = 'sipges_session=' + 'f'.repeat(64);
const WITH_ORIGIN = { origin: '{origin}' };
const SECOND = { 'x-sipges-scope': 'PARITY/PRJ-B' };

export const CASES: readonly ParityCase[] = [
  { name: 'liveness', method: 'GET', path: '/health' },
  { name: 'liveness ignores the query string', method: 'GET', path: '/health?probe=1' },
  { name: 'readiness with the database up', method: 'GET', path: '/health/ready' },
  { name: 'unknown path with a session', method: 'GET', path: '/no-such-route', auth: 'admin' },
  { name: 'trailing slash is another path', method: 'GET', path: '/health/', auth: 'admin' },

  // Session, Origin, project scope and role gates (identity and tenancy middleware, T8).
  { name: 'unknown path without a session', method: 'GET', path: '/no-such-route' },
  { name: 'current scope without a session', method: 'GET', path: '/system/auth/current-scope' },
  {
    name: 'current scope with an unknown session',
    method: 'GET',
    path: '/system/auth/current-scope',
    headers: { cookie: `sipges_session=${'0'.repeat(64)}` },
  },
  {
    name: 'current scope with a session',
    method: 'GET',
    path: '/system/auth/current-scope',
    auth: 'admin',
  },
  {
    name: 'current scope of a project without a grant',
    method: 'GET',
    path: '/system/auth/current-scope',
    auth: 'admin',
    headers: { 'x-sipges-scope': 'ACME/NORTE' },
  },
  {
    name: 'query project_id outside the scope',
    method: 'GET',
    path: '/system/auth/current-scope?project_id=NORTE',
    auth: 'admin',
  },
  { name: 'write without Origin', method: 'POST', path: '/no-such-route', auth: 'admin' },
  {
    name: 'same-origin write reaches routing',
    method: 'POST',
    path: '/no-such-route',
    auth: 'admin',
    sameOrigin: true,
  },
  {
    name: 'JSON body naming another project',
    method: 'POST',
    path: '/api/eventos',
    auth: 'admin',
    sameOrigin: true,
    body: { json: { project_id: 'NORTE', payload: {} } },
  },

  // GET /system/auth/me and /system/auth/providers: public, served by Go (T15).
  { name: 'me without a session is null', method: 'GET', path: '/system/auth/me' },
  {
    name: 'me with an unknown session is null',
    method: 'GET',
    path: '/system/auth/me',
    headers: { cookie: UNKNOWN_TOKEN },
  },
  { name: 'me with a session', method: 'GET', path: '/system/auth/me', auth: 'consulta' },
  { name: 'sign-in providers', method: 'GET', path: '/system/auth/providers' },
  {
    name: 'public write without Origin',
    method: 'POST',
    path: '/system/auth/me',
    auth: 'consulta',
  },

  // Project choice, role gate and request reading, with the seeded consulta and multi users.
  {
    name: 'one project is chosen automatically',
    method: 'GET',
    path: '/no-such-route',
    auth: 'consulta',
  },
  { name: 'two projects need a choice', method: 'GET', path: '/no-such-route', auth: 'multi' },
  {
    name: 'X-SIPGES-Scope chooses',
    method: 'GET',
    path: '/no-such-route',
    auth: 'multi',
    headers: SECOND,
  },
  {
    name: 'the scope cookie chooses',
    method: 'GET',
    path: '/no-such-route',
    auth: 'multi',
    headers: { cookie: 'sipges_scope=PARITY%2FPRJ-B' },
  },
  {
    name: 'an ungranted scope is refused',
    method: 'GET',
    path: '/no-such-route',
    auth: 'consulta',
    headers: SECOND,
  },
  {
    name: 'undecodable project_id',
    method: 'GET',
    path: '/system/no-such-route?project_id=%ZZ',
    auth: 'consulta',
  },
  {
    name: 'encoded project_id key',
    method: 'GET',
    path: '/system/no-such-route?project%5Fid=PRJ-B',
    auth: 'consulta',
  },
  {
    name: 'a write without a session checks the session first',
    method: 'POST',
    path: '/system/no-such-route',
    headers: WITH_ORIGIN,
  },
  {
    name: 'read-only role cannot write',
    method: 'POST',
    path: '/system/no-such-route',
    auth: 'consulta',
    headers: WITH_ORIGIN,
  },
  { name: 'admin-only area', method: 'GET', path: '/system/audit/no-such-route', auth: 'consulta' },
  {
    name: 'payload naming the chosen project',
    method: 'POST',
    path: '/system/no-such-route',
    auth: 'multi',
    headers: { ...WITH_ORIGIN, ...SECOND },
    body: { json: { payload: { Proyecto_ID: 'PRJ-B' } } },
  },
  {
    name: 'payload naming another project',
    method: 'POST',
    path: '/system/no-such-route',
    auth: 'multi',
    headers: { ...WITH_ORIGIN, ...SECOND },
    body: { json: { payload: { project_id: 'PRJ-SECHURA' } } },
  },
  {
    name: 'reset-mfa needs a project',
    method: 'POST',
    path: '/system/auth/accounts/parity-consulta/reset-mfa',
    auth: 'multi',
    headers: WITH_ORIGIN,
  },
  {
    name: 'body with an out-of-range number',
    method: 'POST',
    path: '/system/no-such-route',
    auth: 'multi',
    headers: { ...WITH_ORIGIN, ...SECOND },
    body: { raw: '{"payload":{"Proyecto_ID":"PRJ-SECHURA"},"x":1e400}' },
  },
  {
    name: 'body with a UTF-8 BOM',
    method: 'POST',
    path: '/system/no-such-route',
    auth: 'multi',
    headers: { ...WITH_ORIGIN, ...SECOND },
    body: { raw: '﻿{"project_id":"PRJ-SECHURA"}' },
  },
  {
    name: 'body nested deeper than encoding/json reads',
    method: 'POST',
    path: '/system/no-such-route',
    auth: 'multi',
    headers: { ...WITH_ORIGIN, ...SECOND },
    body: { raw: '{"project_id":"PRJ-SECHURA","x":' + '['.repeat(10001) + ']'.repeat(10001) + '}' },
  },
  {
    name: 'two Origin headers',
    method: 'POST',
    path: '/system/no-such-route',
    auth: 'multi',
    headers: { ...SECOND, origin: '{origin}, http://evil.example' },
  },

  // Paths read as Hono reads them.
  { name: 'encoded slash is not a public path', method: 'GET', path: '/system%2Fauth%2Fme' },
  { name: 'encoded slash is not a machine path', method: 'GET', path: '/hooks%2Fx' },
  {
    name: 'encoded slash with a session',
    method: 'GET',
    path: '/system%2Fauth%2Fme',
    auth: 'consulta',
  },
  {
    name: 'dot segments leave the machine path',
    method: 'GET',
    path: '/hooks/../system/x',
    rawTarget: true,
  },
  {
    name: 'backslash dot segments are refused',
    method: 'GET',
    path: '/hooks\\..\\system\\x',
    rawTarget: true,
  },
  {
    name: 'dot segments reach the public route',
    method: 'GET',
    path: '/system/../system/auth/me',
    auth: 'consulta',
    rawTarget: true,
  },
  {
    name: 'encoded dot segments',
    method: 'GET',
    path: '/system/%2e%2E/system/auth/me',
    auth: 'consulta',
    rawTarget: true,
  },
  {
    name: 'backslashes are refused',
    method: 'GET',
    path: '/system\\auth\\me',
    auth: 'consulta',
    rawTarget: true,
  },
  {
    name: 'trailing dot',
    method: 'GET',
    path: '/system/auth/me/.',
    auth: 'consulta',
    rawTarget: true,
  },
  // Hono routes //x as is (no route): JSON 404, not Go's ServeMux redirect.
  {
    name: 'empty segment',
    method: 'GET',
    path: '//system/auth/me',
    auth: 'consulta',
    rawTarget: true,
  },
  {
    name: 'empty segment without a session',
    method: 'GET',
    path: '//no-such-route',
    rawTarget: true,
  },

  // Ported contexts (contexts/*.ts), reading the synthetic rows of fixtures.ts.
  ...CONTEXT_CASES,
];

/** Problems in a route list; empty when it is valid. */
export const validateCases = (cases: readonly ParityCase[]): string[] => {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.name)) errors.push(`${c.name}: duplicate case name`);
    seen.add(c.name);
    if (!c.path.startsWith('/')) errors.push(`${c.name}: path must start with /`);
    if (c.eventually && !c.present?.length) errors.push(`${c.name}: eventually needs present`);
    if (Boolean(c.perApi) !== JSON.stringify(c).includes('{api}'))
      errors.push(`${c.name}: {api} needs perApi, and perApi needs {api}`);
    for (const path of c.normalize ?? []) {
      if (path.split('.').every((part) => part === '*' || part === '')) {
        errors.push(`${c.name}: normalize path "${path}" is too broad (name a field)`);
      }
    }
  }
  return errors;
};
