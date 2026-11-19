// Keeps passwords out of process arguments for deploy/cloud/move-postgres.sh. Values are read
// from environment variables named on the command line, never from argv.
//   node pg-secrets.mjs strip <ENV NAME> <passfile>
//     prints the postgres:// URL in that variable without its password, and appends the password
//     (if any) to <passfile> as a libpq password file line for that host, port and user;
//   node pg-secrets.mjs scram <ENV NAME>
//     prints the SCRAM-SHA-256 verifier of the password in that variable, as PostgreSQL stores it,
//     so the plain password never reaches the server, its logs or pg_stat_statements.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
// Imported rather than global: eslint gives Node globals only to scripts/ and apps/.
import console from 'node:console';
import process from 'node:process';
import { URL } from 'node:url';

const fail = (message) => {
  console.error(`pg-secrets: ${message}`);
  process.exit(1);
};

const [command, name, passfile] = process.argv.slice(2);
const value = process.env[name ?? ''];
if (!value) fail(`${name ?? 'the variable'} is empty`);

// A password file field: backslash and colon are escaped (libpq, "The Password File").
const field = (text) => text.replaceAll('\\', '\\\\').replaceAll(':', '\\:');

if (command === 'strip') {
  if (!passfile) fail('strip needs a password file');
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${name} is not a postgres:// URL`); // never echo the value
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    fail(`${name} must be a postgres:// URL`);
  }
  if (url.hostname === '' || url.hostname.includes(',')) fail(`${name} must name exactly one host`);
  // The query goes back byte for byte: URLSearchParams would re-encode it (a space as `+`, which
  // libpq does not decode), so only the raw `password` segment is taken out.
  const query = value.includes('?') ? value.slice(value.indexOf('?') + 1).replace(/#.*$/, '') : '';
  const kept = [];
  let password = decodeURIComponent(url.password);
  for (const segment of query.split('&').filter(Boolean)) {
    const [key, ...rest] = segment.split('=');
    const decodedKey = decodeURIComponent(key);
    if (decodedKey === 'passfile') fail(`${name} must not set passfile`);
    if (decodedKey === 'password') password = decodeURIComponent(rest.join('='));
    else kept.push(segment);
  }
  url.password = '';
  url.search = '';
  url.hash = '';
  if (password !== '') {
    const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
    const user = decodeURIComponent(url.username);
    if (user === '') fail(`${name} has a password but no user`);
    const line = [host, url.port || '5432', '*', user, password].map(field).join(':');
    appendFileSync(passfile, `${line}\n`, { mode: 0o600 });
  }
  console.log(kept.length > 0 ? `${url.toString()}?${kept.join('&')}` : url.toString());
} else if (command === 'scram') {
  // SASLprep is the identity for printable ASCII; anything else could be stored differently
  // from what a client sends, so it is refused rather than guessed.
  if (!/^[\x21-\x7e]+$/.test(value)) fail(`${name} must be printable ASCII without spaces`);
  const salt = randomBytes(16);
  const iterations = 4096;
  const salted = pbkdf2Sync(value, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  const b64 = (bytes) => bytes.toString('base64');
  console.log(`SCRAM-SHA-256$${iterations}:${b64(salt)}$${b64(storedKey)}:${b64(serverKey)}`);
} else {
  fail('usage: pg-secrets.mjs strip <ENV NAME> <passfile> | scram <ENV NAME>');
}
