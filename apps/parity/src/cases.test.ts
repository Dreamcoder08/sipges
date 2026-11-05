import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CASES, validateCases } from './cases.ts';

test('the declared route list is valid', () => {
  assert.deepEqual(validateCases(CASES), []);
});

test('duplicate names, relative paths and broad normalizations are refused', () => {
  const errors = validateCases([
    { name: 'a', method: 'GET', path: '/health' },
    { name: 'a', method: 'GET', path: 'health' },
    { name: 'b', method: 'GET', path: '/x', normalize: ['*'] },
    { name: 'c', method: 'GET', path: '/x', normalize: [''] },
  ]);
  assert.deepEqual(errors, [
    'a: duplicate case name',
    'a: path must start with /',
    'b: normalize path "*" is too broad (name a field)',
    'c: normalize path "" is too broad (name a field)',
  ]);
});

test('{api} and perApi go together', () => {
  assert.deepEqual(
    validateCases([
      { name: 'a', method: 'POST', path: '/x', body: { json: { id: 'N-{api}' } } },
      { name: 'b', method: 'POST', path: '/x', perApi: true },
      { name: 'c', method: 'POST', path: '/x/{api}', perApi: true },
    ]),
    [
      'a: {api} needs perApi, and perApi needs {api}',
      'b: {api} needs perApi, and perApi needs {api}',
    ],
  );
});
