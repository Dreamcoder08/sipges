// go-drill.mjs (go-rust-stack T72d3): the visit's G1 and G6 run with sipges-desktop.exe alone,
// with no Node on the PATH; Node keeps one cross check and the way back to TypeScript (G7).
// The drill itself runs on Windows (.github/workflows/windows-desktop.yml, go-mode job).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparedClean, compareArgs, snapshotArgs } from './go-drill.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'go-drill.mjs'), 'utf8');

test('go-drill.mjs: --snapshot and --compare take the scripts\' options after the mode', () => {
  const login = ['--user', 'admin', '--password-file', 'p'];
  assert.deepEqual(snapshotArgs('antes.json', login, 'http://127.0.0.1:8000'), [
    '--snapshot', '--url', 'http://127.0.0.1:8000', '--out', 'antes.json', '--user', 'admin', '--password-file', 'p',
  ]);
  assert.deepEqual(compareArgs('antes.json', login, 'http://127.0.0.1:8000'), [
    '--compare', '--before', 'antes.json', '--url', 'http://127.0.0.1:8000', '--user', 'admin', '--password-file', 'p',
  ]);
});

test('go-drill.mjs: a comparison passes only with exit 0, no difference and every part checked', () => {
  const ok = 'Sign-in: ok (password and MFA code)\nRESULT: no difference\n';
  assert.equal(comparedClean({ status: 0, output: ok }), true);
  assert.equal(comparedClean({ status: 0, output: 'RESULT: no difference (2 audit entries added, listed above)\n' }), true);
  assert.equal(comparedClean({ status: 1, output: ok }), false);
  assert.equal(comparedClean({ status: 0, output: 'RESULT: 1 difference\n' }), false);
  assert.equal(comparedClean({ status: 0, output: 'RESULT: no difference\n  export: not checked (…)\n' }), false);
  assert.equal(comparedClean({ status: 0, output: '  records: not fully checked (x)\nRESULT: no difference\n' }), false);
  assert.equal(comparedClean({ status: 2, output: 'RESULT: not compared (not the managed install)\n' }), false);
});

test('go-drill.mjs: snapshots and comparisons run sipges-desktop without Node; Node only cross-checks once', () => {
  assert.equal(source.match(/snapshotArgs\(/g).length, 2, 'G1 and the snapshot before the update');
  const calls = source.split('\n').filter((line) => /run\(desktop, (snapshotArgs|compareArgs)\(/.test(line));
  assert.equal(calls.length, 3, 'G1, the snapshot before the update and the compare helper');
  for (const call of calls) assert.match(call, /\{ env: noNode,/, call);
  assert.equal(source.match(/'snapshot\.mjs'/g).length, 1, 'one snapshot.mjs: the cross check');
  assert.equal(source.match(/'compare\.mjs'/g).length, 1, 'one compare.mjs: the cross check');
  assert.match(source, /comparedClean\(crossNode\)/);
  assert.match(source, /await compare\('go-on-node-snapshot', beforeNode\)/);
});
