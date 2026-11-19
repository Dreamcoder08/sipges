import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { throughPooler } from './pooler.ts';

const url = 'postgres://owner:synthetic@127.0.0.1:55439/sipges_parity_x?application_name=a';

describe('throughPooler', () => {
  it('leaves the URL unchanged without a pooler', () => {
    assert.equal(throughPooler(url, undefined), url);
    assert.equal(throughPooler(url, ''), url);
  });

  it('swaps only host and port for the pooler', () => {
    assert.equal(
      throughPooler(url, '127.0.0.1:56432'),
      'postgres://owner:synthetic@127.0.0.1:56432/sipges_parity_x?application_name=a',
    );
  });

  it('refuses anything but host:port', () => {
    assert.throws(() => throughPooler(url, 'postgres://127.0.0.1:56432'), /host:port/);
    assert.throws(() => throughPooler(url, '127.0.0.1'), /host:port/);
  });
});
