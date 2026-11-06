import type { ParityCase } from '../types.ts';

/**
 * GET /system/metrics (administrators only, as the role gate decides). Each process counts its
 * own requests, so only the metric families and their types can match: `compareLines` keeps those.
 * The API's identity in the labels is never compared, only that both print the same schema.
 */
export const seed = '';

const path = '/system/metrics';
const compareLines = '^# TYPE ';

export const cases: readonly ParityCase[] = [
  {
    name: 'metrics',
    method: 'GET',
    path,
    auth: 'admin',
    compareLines,
    present: ['sipges_http_requests_total{method="GET"', 'sipges_process_uptime_seconds '],
    absent: ['parity-'],
  },
  { name: 'metrics without a session', method: 'GET', path },
  {
    name: 'metrics with an unknown session',
    method: 'GET',
    path,
    headers: { cookie: `sipges_session=${'0'.repeat(64)}` },
  },
  { name: 'metrics read-only role', method: 'GET', path, auth: 'consulta' },
  { name: 'metrics analyst role', method: 'GET', path, auth: 'multi' },
  {
    name: 'metrics analyst role in a project',
    method: 'GET',
    path,
    auth: 'multi',
    headers: { 'x-sipges-scope': 'SIPGES/PRJ-SECHURA' },
  },
  {
    name: 'metrics of a project without a grant',
    method: 'GET',
    path,
    auth: 'admin',
    headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
  },
  { name: 'metrics with a trailing slash', method: 'GET', path: `${path}/`, auth: 'admin' },
  { name: 'metrics HEAD', method: 'HEAD', path, auth: 'admin', compareLines },
  { name: 'metrics POST', method: 'POST', path, auth: 'admin', sameOrigin: true },
];
