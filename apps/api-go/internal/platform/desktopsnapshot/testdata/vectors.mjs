// Writes vectors.json: what the Node migration scripts compute for tricky synthetic JSON texts,
// so the Go port is pinned to the same bytes (keyed hashes, String(), JSON.stringify).
//
//   node apps/api-go/internal/platform/desktopsnapshot/testdata/vectors.mjs > .../vectors.json
//   pnpm exec prettier --write .../vectors.json
import process from 'node:process';
import { keyed } from '../../../../../../deploy/desktop/migration/client.mjs';
import {
  contentHash,
  exportRowHash,
} from '../../../../../../deploy/desktop/migration/snapshot.mjs';

const SALT = '00ff10a5';
export const TEXTS = [
  'null',
  'true',
  '0',
  '-0',
  '1.0',
  '1e21',
  '1e-7',
  '123e-20',
  '0.000001',
  '1.5e300',
  '1e400',
  '-1e400',
  '12345678901234567890',
  '9007199254740993',
  '0.1',
  '5e-324',
  '"texto"',
  '"\\u00e9 \\ud83d\\ude00 \\ud800 x \\udc00"',
  '"<script>&\\u2028\\u2029\\u007f\\u0001\\b\\f\\n\\r\\t\\"\\\\/"',
  '"ü€😀"',
  '[]',
  '{}',
  '[1,"1",null,true,[],{}]',
  '{"b":1,"a":2,"10":3,"2":4,"02":5,"-1":6,"4294967294":7,"4294967295":8,"Z":9,"é":10,"😀":11,"\\uff5e":12}',
  '{"a":1,"a":2,"b":{"y":[1,{"d":0,"c":1}],"x":null}}',
  '{"id":"U-1","size_bytes":1234}',
  '{"id":"U-1","size_bytes":"1234"}',
  '{"id":"U-1","size_bytes":1234.5}',
  '{"id":"U-1","size_bytes":9007199254740993}',
];

const h = keyed(SALT);
const out = TEXTS.map((text) => {
  const value = JSON.parse(text);
  const row = value !== null && typeof value === 'object' && !Array.isArray(value);
  return {
    text,
    hash: h(value),
    string: String(value),
    number: String(Number(value)),
    stringify: JSON.stringify(value),
    indented: JSON.stringify(value, null, 2) ?? null,
    keys: row ? Object.keys(value) : null,
    content: row ? contentHash(h, value) : null,
    attachments: row ? exportRowHash(h, 'attachments', value) : null,
  };
});
process.stdout.write(`${JSON.stringify({ salt: SALT, vectors: out }, null, 2)}\n`);
