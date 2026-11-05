// Records which stored hashes the TypeScript hashers accept, for the Go port's test
// (../passwords_test.go). Every password and salt is synthetic, written here.
// Run from the repository root (Node 22 needs --experimental-strip-types):
//
//   node apps/api-go/internal/identity/infrastructure/testdata/generate-passwords.mjs          # rewrites passwords.json
//   node apps/api-go/internal/identity/infrastructure/testdata/generate-passwords.mjs --check  # exit 1 when TS disagrees
import { pbkdf2Sync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { argon2id } from '../../../../../api/node_modules/@noble/hashes/argon2.js';
import { hash as nativeHash } from '../../../../../api/node_modules/@node-rs/argon2/index.js';
import { passwordHasher } from '../../../../../api/src/contexts/identity/infrastructure/password-hasher.ts';
import { portablePasswordHasher as portable } from '../../../../../api/src/contexts/identity/infrastructure/portable-password-hasher.ts';

const OUT = fileURLToPath(new URL('./passwords.json', import.meta.url));

const PASSWORDS = {
  ascii: 'synthetic-password-01',
  accents: 'contraseña-sintética-ñandú',
  emoji: 'clave-😀-𝒳-sintética',
  nbsp: 'clave con espacios',
  nul: 'clave\u0000nul-sintética',
  empty: '',
  long: 'x'.repeat(256),
  combining: 'café-sin-normalizar',
};

const b64 = (bytes) => Buffer.from(bytes).toString('base64').replace(/=+$/, '');
const salt = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 255);
const phc = (password, { m, t, p, s = 16, d = 32 }) =>
  `$argon2id$v=19$m=${m},t=${t},p=${p}$${b64(salt(s))}$${b64(
    argon2id(password, salt(s), { m, t, p, dkLen: d, version: 19 }),
  )}`;
const legacy = (password, iterations, s = 16, d = 32) =>
  `pbkdf2_sha256$${iterations}$${Buffer.from(salt(s)).toString('hex')}$${pbkdf2Sync(
    password,
    salt(s),
    iterations,
    d,
    'sha256',
  ).toString('hex')}`;

const flipLastBit = (stored) => `${stored.slice(0, -1)}${stored.endsWith('A') ? 'B' : 'A'}`;

const build = async () => {
  const pw = PASSWORDS.ascii;
  const good = phc(pw, { m: 256, t: 1, p: 1 });
  const lg = legacy(pw, 1000);
  /** [name, password, stored] */
  const rows = [];
  for (const [name, password] of Object.entries(PASSWORDS)) {
    rows.push([`portable hash: ${name}`, password, await portable.hash(password)]);
    rows.push([`native hash: ${name}`, password, await passwordHasher.hash(password)]);
    rows.push([`legacy 310000: ${name}`, password, legacy(password, 310000)]);
    rows.push([`wrong password: ${name}`, `${password}!`, await portable.hash(password)]);
    rows.push([`wrong legacy: ${name}`, `${password}!`, legacy(password, 1000)]);
  }
  rows.push(['native library defaults', pw, await nativeHash(pw, { algorithm: 2 })]);
  rows.push(['cost m=8 t=1 p=1', pw, phc(pw, { m: 8, t: 1, p: 1 })]);
  rows.push(['cost m=1024 t=3 p=2', pw, phc(pw, { m: 1024, t: 3, p: 2 })]);
  rows.push(['cost m=2051 t=2 p=4, not a multiple', pw, phc(pw, { m: 2051, t: 2, p: 4 })]);
  rows.push(['cost at t limit', pw, phc(pw, { m: 64, t: 10, p: 1 })]);
  rows.push(['cost at m limit', pw, phc(pw, { m: 65536, t: 1, p: 1 })]);
  rows.push(['short salt 8', pw, phc(pw, { m: 64, t: 1, p: 1, s: 8 })]);
  rows.push(['digest 16', pw, phc(pw, { m: 64, t: 1, p: 1, d: 16 })]);
  rows.push(['digest 64', pw, phc(pw, { m: 64, t: 1, p: 1, d: 64 })]);
  rows.push(['legacy 1 iteration', pw, legacy(pw, 1)]);
  rows.push(['legacy at limit', pw, legacy(pw, 1_000_000)]);
  rows.push(['legacy short digest', pw, legacy(pw, 1000, 4, 8)]);
  rows.push(['legacy long digest', pw, legacy(pw, 1000, 32, 64)]);

  rows.push(['refused: empty', pw, '']);
  rows.push(['refused: plain text', pw, pw]);
  rows.push(['refused: argon2i', pw, good.replace('$argon2id$', '$argon2i$')]);
  rows.push(['refused: version 16', pw, good.replace('v=19', 'v=16')]);
  rows.push(['refused: no version', pw, good.replace('v=19$', '')]);
  rows.push([
    'refused: m over limit',
    pw,
    phc(pw, { m: 256, t: 1, p: 1 }).replace('m=256', 'm=65537'),
  ]);
  rows.push(['refused: t over limit', pw, good.replace('t=1', 't=11')]);
  rows.push(['refused: p over limit', pw, good.replace('p=1', 'p=5')]);
  rows.push(['refused: p zero', pw, good.replace('p=1', 'p=0')]);
  rows.push(['refused: t zero', pw, good.replace('t=1', 't=0')]);
  rows.push(['refused: m below 8p', pw, good.replace('m=256', 'm=7')]);
  rows.push(['refused: padded salt', pw, good.replace(/\$([^$]+)\$([^$]+)$/, '$$$1=$$$2')]);
  rows.push(['refused: line break in digest', pw, good.replace(/.$/, '\n$&')]);
  rows.push(['refused: trailing newline', pw, `${good}\n`]);
  rows.push([
    'refused: url alphabet',
    pw,
    `$argon2id$v=19$m=64,t=1,p=1$${'_'.repeat(22)}$${'-'.repeat(43)}`,
  ]);
  rows.push([
    'refused: salt too short',
    pw,
    good.replace(/\$[^$]+\$([^$]+)$/, `$${b64(salt(7))}$$$1`),
  ]);
  rows.push(['refused: digest too short', pw, good.replace(/\$[^$]+$/, `$${b64(salt(15))}`)]);
  rows.push(['refused: digest too long', pw, phc(pw, { m: 64, t: 1, p: 1, d: 65 })]);
  rows.push(['refused: base64 length 1 mod 4', pw, good.replace(/\$[^$]+$/, '$$AAAAA')]);
  rows.push(['refused: bit flipped', pw, flipLastBit(good)]);
  rows.push(['refused: legacy over limit', pw, legacy(pw, 1000).replace('$1000$', '$1000001$')]);
  rows.push(['refused: legacy zero iterations', pw, lg.replace('$1000$', '$0$')]);
  rows.push(['refused: legacy 8 digit iterations', pw, lg.replace('$1000$', '$10000000$')]);
  rows.push([
    'refused: legacy upper hex',
    pw,
    lg.toUpperCase().replace('PBKDF2_SHA256', 'pbkdf2_sha256'),
  ]);
  rows.push(['refused: legacy odd hex', pw, `${lg}0`]);
  rows.push(['refused: legacy extra field', pw, `${lg}$00`]);
  rows.push(['refused: legacy no digest', pw, lg.replace(/\$[^$]+$/, '$')]);
  rows.push(['refused: legacy digest changed', pw, flipLegacy(lg)]);
  rows.push(['refused: other pbkdf2', pw, lg.replace('pbkdf2_sha256', 'pbkdf2_sha512')]);
  return rows;
};

const flipLegacy = (stored) => `${stored.slice(0, -1)}${stored.endsWith('0') ? '1' : '0'}`;

/** What the production hasher decides; rehash is its needsRehash. */
const judge = async ([name, password, stored]) => ({
  name,
  password,
  stored,
  ok: await portable.verify(password, stored),
  rehash: portable.needsRehash(stored),
});

if (process.argv.includes('--check')) {
  const recorded = JSON.parse(readFileSync(OUT, 'utf8'));
  let drifted = 0;
  for (const row of recorded) {
    const now = await judge([row.name, row.password, row.stored]);
    if (now.ok !== row.ok || now.rehash !== row.rehash) {
      console.error('drifted:', row.name);
      drifted += 1;
    }
  }
  process.exit(drifted ? 1 : 0);
}

const rows = [];
for (const row of await build()) rows.push(await judge(row));
const config = await resolveConfig(OUT);
writeFileSync(OUT, await format(JSON.stringify(rows), { ...config, parser: 'json' }));
console.log(`${rows.length} rows, ${rows.filter((r) => r.ok).length} accepted`);
