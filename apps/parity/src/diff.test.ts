import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NORMALIZED, checkText, compare, normalize, type Observed } from './diff.ts';

const json = (status: number, body: unknown): Observed => ({
  status,
  contentType: 'application/json',
  body: { kind: 'json', value: body },
});

test('identical status, media type and JSON give no mismatch', () => {
  assert.deepEqual(
    compare(json(200, { status: 'ok', n: [1, 2] }), json(200, { status: 'ok', n: [1, 2] })),
    [],
  );
});

test('object key order is not part of the JSON value', () => {
  assert.deepEqual(compare(json(200, { a: 1, b: 2 }), json(200, { b: 2, a: 1 })), []);
});

test('a different status is reported', () => {
  assert.deepEqual(compare(json(401, { detail: 'x' }), json(404, { detail: 'x' })), [
    { field: 'status', ts: 401, go: 404 },
  ]);
});

test('the media type is compared without its parameters', () => {
  const go: Observed = { ...json(200, {}), contentType: 'application/json; charset=utf-8' };
  assert.deepEqual(compare(json(200, {}), go), []);
  const text: Observed = { ...json(200, {}), contentType: 'text/plain' };
  assert.deepEqual(compare(json(200, {}), text), [
    { field: 'content-type', ts: 'application/json', go: 'text/plain' },
  ]);
});

test('every differing JSON path is reported, including missing keys and array lengths', () => {
  const ts = json(200, { detail: 'a', list: [1, 2], only: true, nested: { x: 1 } });
  const go = json(200, { detail: 'b', list: [1], nested: { x: '1' } });
  assert.deepEqual(compare(ts, go), [
    { field: 'body', path: '$.detail', ts: 'a', go: 'b' },
    { field: 'body', path: '$.list[1]', ts: 2, go: undefined },
    { field: 'body', path: '$.nested.x', ts: 1, go: '1' },
    { field: 'body', path: '$.only', ts: true, go: undefined },
  ]);
});

test('null and a missing key differ', () => {
  assert.deepEqual(compare(json(200, { a: null }), json(200, {})), [
    { field: 'body', path: '$.a', ts: null, go: undefined },
  ]);
});

test('a JSON body never equals a text body', () => {
  const text: Observed = {
    status: 200,
    contentType: 'application/json',
    body: { kind: 'text', value: '{}' },
  };
  assert.deepEqual(compare(json(200, {}), text), [{ field: 'body', path: '$', ts: {}, go: '{}' }]);
});

test('normalize replaces only the declared paths, through arrays with *', () => {
  const body = {
    id: 7,
    at: 'x',
    items: [
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ],
  };
  assert.deepEqual(normalize(body, ['id', 'items.*.id']), {
    id: NORMALIZED,
    at: 'x',
    items: [
      { id: NORMALIZED, name: 'a' },
      { id: NORMALIZED, name: 'b' },
    ],
  });
  assert.deepEqual(body.id, 7, 'the input is not mutated');
});

test('a normalized path absent on one side is still a mismatch', () => {
  assert.deepEqual(compare(json(200, { id: 1 }), json(200, {}), ['id']), [
    { field: 'body', path: '$.id', ts: NORMALIZED, go: undefined },
  ]);
});

test('normalized fields compare equal when present on both sides', () => {
  assert.deepEqual(
    compare(json(200, { id: 1, ok: true }), json(200, { id: 2, ok: true }), ['id']),
    [],
  );
});

test('checkText reports text an answer lacks or must not hold', () => {
  const body = { kind: 'json', value: { a: ['propio'] } } as const;
  assert.deepEqual(checkText(body, ['propio'], ['ajeno']), []);
  assert.deepEqual(checkText(body), []);
  assert.deepEqual(checkText(body, ['ajeno'], ['propio']), [
    'missing "ajeno"',
    'unexpected "propio"',
  ]);
  assert.deepEqual(checkText({ kind: 'text', value: 'ajeno' }, [], ['ajeno']), [
    'unexpected "ajeno"',
  ]);
});

test('compareLines compares only the matching lines of a text answer', () => {
  const text = (value: string): Observed => ({
    status: 200,
    contentType: 'text/plain',
    body: { kind: 'text', value },
  });
  assert.deepEqual(compare(text('# T a\nx 1'), text('# T a\nx 2'), [], '^# T '), []);
  assert.equal(compare(text('# T a\nx 1'), text('# T b\nx 1'), [], '^# T ').length, 1);
  assert.equal(compare(text('x 1'), text('x 2')).length, 1);
});
