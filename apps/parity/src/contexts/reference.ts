import type { ParityCase } from '../types.ts';

/**
 * Reference, read-only (T20): the repository references of `data/*.json`, registered to the
 * default project (SIPGES/PRJ-SECHURA) only; any other project gets `available: false`. Every role
 * may read them, so the 403s come from the project scope, never from the role gate. No seed: the
 * data is embedded in both APIs.
 */
export const seed = '';

export const cases: readonly ParityCase[] = [
  '/system/project-coordinates',
  '/system/canonical-entities',
].flatMap((path): ParityCase[] => [
  { name: `${path} without a session`, method: 'GET', path },
  {
    name: `${path} with an unknown session`,
    method: 'GET',
    path,
    headers: { cookie: `sipges_session=${'f'.repeat(64)}` },
  },
  { name: `${path} with a session`, method: 'GET', path, auth: 'admin' },
  {
    name: `${path} with project_id of the scope`,
    method: 'GET',
    path: `${path}?project_id=PRJ-SECHURA`,
    auth: 'admin',
  },
  {
    name: `${path} of a project without a grant`,
    method: 'GET',
    path,
    auth: 'admin',
    headers: { 'x-sipges-scope': 'ACME/NORTE' },
  },
  {
    name: `${path} with project_id outside the scope`,
    method: 'GET',
    path: `${path}?project_id=NORTE`,
    auth: 'admin',
  },
  { name: `${path} rejects a write`, method: 'POST', path, auth: 'admin', sameOrigin: true },
  { name: `${path} for a read-only user`, method: 'GET', path, auth: 'consulta' },
  {
    name: `${path} of another project is unavailable`,
    method: 'GET',
    path,
    auth: 'multi',
    headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
  },
]);
