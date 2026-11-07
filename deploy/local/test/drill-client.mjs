/* global AbortSignal, Blob, Buffer, FormData, URLSearchParams, console, fetch, process, setTimeout */
// The browser's part of the restore drill, over real HTTPS and with synthetic values only.
// `seed` signs in, enrols MFA, creates a record and uploads a file, then saves what it did;
// `check` signs in with that MFA secret and proves the record and the file's bytes are back.
// Plain Node: the drill must not depend on anything this repository builds.
import { createHash, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [mode, statePath] = process.argv.slice(2);
const base = process.env.SIPGES_DRILL_URL;
const username = process.env.SIPGES_DRILL_USER ?? 'admin';
const password = process.env.SIPGES_DRILL_PASSWORD;
const fail = (message) => {
  console.error(`drill: ${message}`);
  process.exit(1);
};
const expect = (label, condition, detail = '') => {
  if (!condition) fail(`${label} ${detail}`);
  console.log(`ok - ${label}`);
};

const base32 = (text) => {
  let bits = '';
  for (const char of text.replace(/=+$/, '')) {
    bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char).toString(2).padStart(5, '0');
  }
  return Buffer.from(bits.match(/.{8}/g).map((byte) => parseInt(byte, 2)));
};
const stepNow = () => Math.floor(Date.now() / 30000);
const totp = (secret, step = stepNow()) => {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32(secret)).update(counter).digest();
  const at = mac[19] & 15;
  return String((mac.readUInt32BE(at) & 0x7fffffff) % 1_000_000).padStart(6, '0');
};

let cookie = '';
const call = async (path, init = {}) => {
  const headers = { Origin: base, Accept: 'application/json', ...init.headers };
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(base + path, { ...init, headers });
  const set = response.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return response;
};
const login = (otp) =>
  call('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password, otp }),
  });
const json = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const checkHeaders = async () => {
  const shell = await fetch(`${base}/`, { headers: { Accept: 'text/html' } });
  expect('the web app is served', shell.status === 200, `status ${shell.status}`);
  const csp = shell.headers.get('content-security-policy') ?? '';
  expect('the shell has the strict policy', csp.includes("script-src 'self'"), csp);
  expect('HSTS is on', Boolean(shell.headers.get('strict-transport-security')));
  expect('frames are refused', shell.headers.get('x-frame-options') === 'DENY');
  const html = await shell.text();
  const script = html.match(/assets\/[A-Za-z0-9._-]+\.js/)?.[0];
  expect('the shell names a bundle', Boolean(script));
  const bundle = await fetch(`${base}/${script}`);
  expect('the bundle loads', bundle.status === 200);
  expect('the bundle is cached', (bundle.headers.get('cache-control') ?? '').includes('immutable'));
  const wrongHost = await fetch(`${base}/health`, { headers: { Accept: 'application/json' } });
  expect('health answers', wrongHost.status === 200);
  const refused = await call('/api/compromisos');
  expect('the API asks for a session', refused.status === 401, `status ${refused.status}`);
  expect('API answers are not stored', refused.headers.get('cache-control') === 'no-store');
};

const seed = async () => {
  await checkHeaders();
  const first = await login('');
  expect('the first administrator signs in', first.status === 200, `status ${first.status}`);
  expect('the session cookie is Secure', (first.headers.get('set-cookie') ?? '').includes('Secure'));
  expect('the session cookie is HttpOnly', (first.headers.get('set-cookie') ?? '').includes('HttpOnly'));

  const blocked = await call('/api/compromisos');
  expect('MFA is required before any data', blocked.status === 403, `status ${blocked.status}`);

  const setup = await call('/system/auth/totp/setup', { method: 'POST' });
  expect('MFA enrolment starts', setup.status === 200, `status ${setup.status}`);
  const { secret } = await setup.json();
  const enabled = await call('/system/auth/totp/enable', json({ code: totp(secret) }));
  expect('MFA enrolment finishes', enabled.status === 200, `status ${enabled.status}`);
  cookie = '';
  const missing = await login('');
  expect('sign-in now needs the code', missing.status === 401, `status ${missing.status}`);
  // The server refuses a code twice, and it accepts one step ahead: this one is unused.
  const usedStep = stepNow() + 1;
  const again = await login(totp(secret, usedStep));
  expect('sign-in with the code works', again.status === 200, `status ${again.status}`);

  const marker = `DRILL-${Date.now()}`;
  const created = await call('/api/compromisos', json({ payload: { ID_Compromiso: marker, Texto: 'synthetic drill record' } }));
  expect('a record is created', created.status === 200, `status ${created.status}`);

  const bytes = `synthetic evidence ${marker}\n`;
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: 'text/plain' }), 'drill-evidence.txt');
  form.set('linked_module', 'Compromisos');
  form.set('linked_record_id', marker);
  const uploaded = await call('/system/uploads', { method: 'POST', body: form });
  const { attachment } = await uploaded.json();
  expect('evidence is uploaded', uploaded.status === 200 && Boolean(attachment?.id), `status ${uploaded.status}`);
  const stored = await call(`/system/uploads/${attachment.id}/download`);
  expect('the evidence downloads', stored.status === 200 && (await stored.text()) === bytes, `status ${stored.status}`);

  writeFileSync(statePath, JSON.stringify({
    secret,
    usedStep,
    marker,
    uploadId: attachment.id,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }), { mode: 0o600 });
};

// Caddy must pass the stream on as it comes: the app's live updates depend on it.
const checkStream = async () => {
  const stream = await call('/system/events', {
    headers: { Accept: 'text/event-stream' },
    signal: AbortSignal.timeout(5000),
  });
  expect('the live stream opens at once', stream.status === 200, `status ${stream.status}`);
  expect(
    'the live stream is an event stream',
    (stream.headers.get('content-type') ?? '').startsWith('text/event-stream'),
  );
  expect('the live stream is not compressed', !stream.headers.get('content-encoding'));
  await stream.body.cancel();
};

const check = async () => {
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  await checkHeaders();
  // A restore brings back the record of the last code used, so that code stays refused.
  while (stepNow() <= state.usedStep) await new Promise((done) => setTimeout(done, 1000));
  const signedIn = await login(totp(state.secret));
  expect('sign-in with the same authenticator works after the restore', signedIn.status === 200, `status ${signedIn.status}`);
  const record = await call(`/api/compromisos/${state.marker}`);
  expect('the record is back', record.status === 200, `status ${record.status}`);
  const body = await record.json();
  expect('the record is intact', JSON.stringify(body).includes('synthetic drill record'));
  const file = await call(`/system/uploads/${state.uploadId}/download`);
  expect('the evidence is back', file.status === 200, `status ${file.status}`);
  const bytes = Buffer.from(await file.arrayBuffer());
  expect('the evidence bytes match', createHash('sha256').update(bytes).digest('hex') === state.sha256);
  await checkStream();
};

const expectAbsent = async () => {
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const first = await login('');
  expect('the wiped install starts empty: the new administrator has no MFA yet', first.status === 200, `status ${first.status}`);
  const setup = await call('/system/auth/totp/setup', { method: 'POST' });
  const { secret } = await setup.json();
  await call('/system/auth/totp/enable', json({ code: totp(secret) }));
  cookie = '';
  await login(totp(secret, stepNow() + 1));
  const record = await call(`/api/compromisos/${state.marker}`);
  expect('the record is gone after the wipe', record.status === 404, `status ${record.status}`);
};

await { seed, check, absent: expectAbsent }[mode]();
