import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { academicDemo, DEMO_SCOPE } from './dataset.ts';
import { seedDemo, seedDemoEvidence, type DemoRequest } from './seed.ts';

class DemoImportError extends Error {}

/** Credentials are supplied via environment, never arguments, output, files or a preset. */
const main = async () => {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (args[0] === '--export' && args[1] && args.length === 2) {
    await writeFile(args[1], JSON.stringify(academicDemo(), null, 2) + '\n', { flag: 'wx' });
    console.log('Synthetic demo manifest exported (122 records).');
    return;
  }
  if (args.some((arg) => arg !== '--apply'))
    throw new Error('Use --export <new-file> or --apply; no flags means dry run');
  const base = new URL(process.env.MASCLI_DEMO_URL ?? '');
  if (
    base.protocol !== 'https:' &&
    !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname))
  )
    throw new Error('Use HTTPS for a remote demo');
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/')
    throw new Error('Use a base URL without credentials, query or path');
  const username = process.env.MASCLI_DEMO_USERNAME;
  const password = process.env.MASCLI_DEMO_PASSWORD;
  if (!username || !password)
    throw new Error('Set MASCLI_DEMO_USERNAME and MASCLI_DEMO_PASSWORD privately');
  let cookie = '';
  const call = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Origin', base.origin);
    headers.set('X-MASCLI-Scope', DEMO_SCOPE);
    if (cookie) headers.set('Cookie', cookie);
    const response = await fetch(new URL(path, base), { ...init, headers, redirect: 'error' });
    if (!response.ok) {
      const retry = Number(response.headers.get('retry-after'));
      throw new DemoImportError(
        `Demo API ${path.split('?')[0]} returned ${response.status}${retry > 0 ? `; retry after ${retry} seconds` : ''}`,
      );
    }
    return response;
  };
  const login = await call('/login', {
    method: 'POST',
    body: new URLSearchParams({ username, password, otp: process.env.MASCLI_DEMO_OTP ?? '' }),
  });
  const token = /mascli_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1];
  if (!token) throw new Error('Demo login did not establish a session');
  cookie = `mascli_session=${token}`;
  try {
    const request: DemoRequest = async (method, path, body) =>
      (
        await call(path, {
          method,
          ...(body === undefined
            ? {}
            : body instanceof FormData
              ? { body }
              : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        })
      ).json();
    const records = await seedDemo(request, args.includes('--apply'));
    const evidence = args.includes('--apply') ? await seedDemoEvidence(request) : {};
    console.log(JSON.stringify({ ...records, ...evidence }));
  } finally {
    await call('/logout', { method: 'POST' });
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // Network/library errors can embed connection details. Only report the error class.
    console.error(
      'Academic demo import failed:',
      error instanceof DemoImportError
        ? error.message
        : error instanceof Error
          ? error.name
          : 'unknown',
    );
    process.exitCode = 1;
  });
}
