import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WriteProof, routeOf } from './write-proof.ts';
import type { ParityCase } from './types.ts';
import type { WriteRoute } from './write-routes.ts';

const domain: WriteRoute = { method: 'POST', path: '/api/eventos', rows: 'domain' };
const byId: WriteRoute = {
  method: 'PUT',
  path: '/system/links/:id/evidence',
  rows: ['link_evidence'],
};
const compute: WriteRoute = { method: 'POST', path: '/system/analyze', rows: 'none', why: 'reads' };
const literal: WriteRoute = { method: 'POST', path: '/api/:module/import', rows: 'domain' };
const exact: WriteRoute = { method: 'POST', path: '/api/special/import', rows: 'domain' };
const routes = [domain, byId, compute, literal, exact];

const call = (method: ParityCase['method'], path: string): ParityCase => ({
  name: `${method} ${path}`,
  method,
  path,
});
const both = (table: string) =>
  [
    { api: 'ts', table },
    { api: 'go', table },
  ] as const;
const unproved = (proof: WriteProof) => proof.unproved().map((u) => u.route.path);

test('a route is proved by 2xx on both APIs and rows from both', () => {
  const proof = new WriteProof([domain]);
  proof.record(call('POST', '/api/eventos'), 201, 200, both('module_records'));
  assert.deepEqual(unproved(proof), []);
});

test('two equal 500s, which parity alone passes, prove nothing', () => {
  const proof = new WriteProof([domain]);
  proof.record(call('POST', '/api/eventos'), 500, 500, both('module_records'));
  assert.deepEqual(unproved(proof), ['/api/eventos']);
});

test('a 200 that wrote no row, as forced RLS allows silently, proves nothing', () => {
  const proof = new WriteProof([domain]);
  proof.record(call('POST', '/api/eventos'), 200, 200, []);
  assert.deepEqual(unproved(proof), ['/api/eventos']);
});

test('rows from one API do not prove the other', () => {
  const proof = new WriteProof([domain]);
  proof.record(call('POST', '/api/eventos'), 200, 200, [{ api: 'ts', table: 'module_records' }]);
  assert.deepEqual(unproved(proof), ['/api/eventos']);
});

test('an audit or session row alone is not the row the route promised', () => {
  const proof = new WriteProof([domain]);
  proof.record(call('POST', '/api/eventos'), 200, 200, [...both('audit'), ...both('sessions')]);
  assert.deepEqual(unproved(proof), ['/api/eventos']);
});

test('a route that names its table needs that table', () => {
  const proof = new WriteProof([byId]);
  proof.record(call('PUT', '/system/links/L1/evidence'), 200, 200, both('record_links'));
  assert.deepEqual(unproved(proof), ['/system/links/:id/evidence']);
  proof.record(call('PUT', '/system/links/L1/evidence'), 200, 200, both('link_evidence'));
  assert.deepEqual(unproved(proof), []);
});

test('a route declared to write nothing still needs its normal status', () => {
  const proof = new WriteProof([compute]);
  proof.record(call('POST', '/system/analyze'), 500, 500, []);
  assert.deepEqual(unproved(proof), ['/system/analyze']);
  proof.record(call('POST', '/system/analyze'), 200, 200, []);
  assert.deepEqual(unproved(proof), []);
});

test('a route whose normal answer is not 2xx names it', () => {
  const route: WriteRoute = { method: 'POST', path: '/select-project', rows: 'none', normal: 303 };
  const proof = new WriteProof([route]);
  proof.record(call('POST', '/select-project'), 200, 200, []);
  assert.deepEqual(unproved(proof), ['/select-project']);
  proof.record(call('POST', '/select-project'), 303, 303, []);
  assert.deepEqual(unproved(proof), []);
});

test('a blocked route gives a reason and still needs a case that reaches it', () => {
  const route: WriteRoute = { method: 'POST', path: '/x', rows: 'none', blocked: 'calls a vendor' };
  const proof = new WriteProof([route]);
  assert.deepEqual(unproved(proof), ['/x']);
  proof.record(call('POST', '/x'), 502, 502, []);
  assert.deepEqual(unproved(proof), []);
  assert.deepEqual(
    proof.blocked().map((r) => r.path),
    ['/x'],
  );
});

test('a route no case calls is unproved', () => {
  assert.deepEqual(unproved(new WriteProof([domain])), ['/api/eventos']);
});

test('routeOf ignores the query, fills parameters and prefers the literal route', () => {
  assert.equal(routeOf(call('POST', '/api/eventos?x=1'), routes), domain);
  assert.equal(routeOf(call('PUT', '/system/links/{w}/evidence'), routes), byId);
  assert.equal(routeOf(call('POST', '/api/special/import'), routes), exact);
  assert.equal(routeOf(call('POST', '/api/other/import'), routes), literal);
  assert.equal(routeOf(call('GET', '/api/eventos'), routes), undefined);
});
