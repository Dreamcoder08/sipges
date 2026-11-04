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

test('a raw body is sent byte for byte and a raw target reaches the server unnormalized', async () => {
  const seen: { url: string | undefined; type: string | undefined; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      seen.push({ url: req.url, type: req.headers['content-type'], body });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":1}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const url = `http://127.0.0.1:${port}`;
    await send(
      url,
      { name: 'r', method: 'POST', path: '/x', body: { raw: '﻿{"a":1e400}' } },
      undefined,
      1_000,
    );
    const raw = await send(
      url,
      { name: 't', method: 'GET', path: '/hooks/../system/x?q=1', rawTarget: true },
      undefined,
      1_000,
    );
    assert.deepEqual(seen, [
      { url: '/x', type: 'application/json', body: '﻿{"a":1e400}' },
      { url: '/hooks/../system/x?q=1', type: undefined, body: '' },
    ]);
    assert.deepEqual(raw, {
      status: 200,
      contentType: 'application/json',
      body: { kind: 'json', value: { ok: 1 } },
    });
  } finally {
    server.close();
  }
});

test('sameOrigin sends each API its own base URL as Origin', async () => {
  const seen: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.origin);
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const url = `http://127.0.0.1:${port}`;
    await send(url, { name: 's', method: 'POST', path: '/', sameOrigin: true }, undefined, 1_000);
    assert.deepEqual(seen, [url]);
  } finally {
    server.close();
  }
});

test('{api} names each API in a perApi case and reads back as {api} in the answer', async () => {
  const seen: { url: string | undefined; scope: string | undefined; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      seen.push({ url: req.url, scope: req.headers['x-sipges-scope'] as string, body });
      const echoed = JSON.parse(body) as { project_id: string };
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ scope: `P/${echoed.project_id}`, plain: 'TS' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const url = `http://127.0.0.1:${port}`;
    const c = {
      name: 'per api',
      method: 'POST' as const,
      path: '/x?p=N-{api}',
      headers: { 'x-sipges-scope': 'P/N-{api}' },
      body: { json: { project_id: 'N-{api}' } },
      perApi: true as const,
    };
    const ts = await send(url, c, undefined, 1_000, 'ts');
    const go = await send(url, c, undefined, 1_000, 'go');
    assert.deepEqual(seen, [
      { url: '/x?p=N-TSAPI', scope: 'P/N-TSAPI', body: '{"project_id":"N-TSAPI"}' },
      { url: '/x?p=N-GOAPI', scope: 'P/N-GOAPI', body: '{"project_id":"N-GOAPI"}' },
    ]);
    assert.deepEqual(ts.body, { kind: 'json', value: { scope: 'P/N-{api}', plain: 'TS' } });
    assert.deepEqual(go.body, ts.body);
  } finally {
    server.close();
  }
});
