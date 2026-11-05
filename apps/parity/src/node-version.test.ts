import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nodeVersionProblem } from './node-version.ts';

test('parity runs on the Node major CI uses', () => {
  assert.equal(nodeVersionProblem('v22.21.0', false), null);
});

test('another Node major is refused with the way out', () => {
  assert.match(
    nodeVersionProblem('v26.7.0', false) ?? '',
    /needs Node 22.*found v26\.7\.0.*SIPGES_PARITY_ANY_NODE/,
  );
});

test('the override lets another Node major run', () => {
  assert.equal(nodeVersionProblem('v26.7.0', true), null);
});
