import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { send } from './request.ts';

test('a request that gets no answer fails after the timeout', async () => {
  const server = createServer(() => {
    // Never answers.
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const began = Date.now();
    await assert.rejects(
      send(
        `http://127.0.0.1:${port}`,
        { name: 'stuck', method: 'GET', path: '/x' },
        undefined,
        200,
      ),
      /GET \/x timed out after 200 ms/,
    );
    assert.ok(Date.now() - began < 2_000);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('a JSON answer is parsed and the session cookie is sent only to auth cases', async () => {
  const cookies: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    cookies.push(req.headers.cookie);
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const url = `http://127.0.0.1:${port}`;
    const plain = await send(url, { name: 'a', method: 'GET', path: '/' }, 'sid=1', 1_000);
    await send(url, { name: 'b', method: 'GET', path: '/', auth: 'admin' }, 'sid=1', 1_000);
    assert.deepEqual(plain, {
      status: 200,
      contentType: 'application/json',
      body: { kind: 'json', value: { ok: true } },
    });
    assert.deepEqual(cookies, [undefined, 'sid=1']);
  } finally {
    server.close();
  }
});

test('{origin} becomes each API base URL and a case cookie joins the session cookie', async () => {
  const seen: { origin: string | undefined; cookie: string | undefined }[] = [];
  const server = createServer((req, res) => {
    seen.push({ origin: req.headers.origin, cookie: req.headers.cookie });
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const url = `http://127.0.0.1:${port}`;
    await send(
      url,
      {
        name: 'c',
        method: 'POST',
        path: '/',
        auth: 'admin',
        headers: { origin: '{origin}', cookie: 'sipges_scope=A%2FB' },
      },
      'sipges_session=s',
      1_000,
    );
    await send(
      url,
      { name: 'd', method: 'GET', path: '/', headers: { cookie: 'x=1' } },
      'sipges_session=s',
      1_000,
    );
    assert.deepEqual(seen, [
      { origin: url, cookie: 'sipges_scope=A%2FB; sipges_session=s' },
      { origin: undefined, cookie: 'x=1' },
    ]);
  } finally {
    server.close();
  }
});
