// Records TOTP codes, enrolment URIs and sealed secrets from the TypeScript sources, for the Go
// port's test (../totp_test.go). Secrets and keys are synthetic, written here.
// Run from the repository root (Node 22 needs --experimental-strip-types):
//
//   node apps/api-go/internal/identity/infrastructure/testdata/generate-totp.mjs          # rewrites totp.json
//   node apps/api-go/internal/identity/infrastructure/testdata/generate-totp.mjs --check  # exit 1 when TS disagrees
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { createSecretCipher } from '../../../../../api/src/contexts/identity/infrastructure/secret-cipher.ts';
import { totp } from '../../../../../api/src/contexts/identity/infrastructure/totp.ts';

const OUT = fileURLToPath(new URL('./totp.json', import.meta.url));
const KEY = Buffer.alloc(32, 7);
const PREVIOUS = Buffer.alloc(32, 9);
const SECRETS = [
  'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  'JBSWY3DPEHPK3PXP',
  'jbswy3dpehpk3pxp',
  'JBSWY3DPEHPK3PXP====',
  'MFRGG',
  'A',
];
const MOMENTS = [
  0, 29_999, 30_000, 59_000, 1_111_111_109_000, 1_234_567_890_000, 2_000_000_000_000,
];
const LOGINS = ['ana.perez', 'ñandú pérez', 'a/b?c&d', '😀', "it's(a)~*!"];

const build = () => ({
  key: KEY.toString('base64'),
  previous: PREVIOUS.toString('base64'),
  codes: SECRETS.flatMap((secret) =>
    MOMENTS.map((at) => ({ secret, at, code: totp.codeAt(secret, new Date(at)) })),
  ),
  uris: LOGINS.map((username) => ({
    username,
    uri: totp.uri(username, 'JBSWY3DPEHPK3PXP'),
  })),
  sealed: ['JBSWY3DPEHPK3PXP', 'ñandú 😀', ''].flatMap((plain) => [
    { plain, value: createSecretCipher(KEY).seal(plain) },
    { plain, value: createSecretCipher(PREVIOUS).seal(plain) },
  ]),
});

const judge = (recorded) => {
  const opener = createSecretCipher(KEY, [PREVIOUS]);
  const drifted = [];
  for (const row of recorded.codes)
    if (totp.codeAt(row.secret, new Date(row.at)) !== row.code) drifted.push(row);
  for (const row of recorded.uris)
    if (totp.uri(row.username, 'JBSWY3DPEHPK3PXP') !== row.uri) drifted.push(row);
  for (const row of recorded.sealed) if (opener.open(row.value) !== row.plain) drifted.push(row);
  return drifted;
};

if (process.argv.includes('--check')) {
  const drifted = judge(JSON.parse(readFileSync(OUT, 'utf8')));
  if (drifted.length > 0) console.error('drifted:', drifted);
  process.exit(drifted.length > 0 ? 1 : 0);
}

const config = await resolveConfig(OUT);
writeFileSync(OUT, await format(JSON.stringify(build()), { ...config, parser: 'json' }));
