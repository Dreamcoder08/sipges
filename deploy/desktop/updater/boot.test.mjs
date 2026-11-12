// The migration and readiness boot (`bootCheck`) picks a free port and releases it before the
// version binds it, so another program can take it in between. The boot must then try again on
// another port instead of failing the update or the first start. Synthetic version, temp dirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootCheck, freePort } from './boot.mjs';

// No error handler: a port already in use ends it with EADDRINUSE, like the API's serve().
const APP = `import { createServer } from 'node:http';
createServer((req, res) => {
  if (req.url === '/health/ready') return res.end('{"status":"ready"}');
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><title>SIPGES</title>');
}).listen(Number(process.env.SIPGES_PORT), '127.0.0.1');
`;

async function withVersion(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'sipges-boot-'));
  // Another program holding a port: it accepts and drops every connection, never answers HTTP.
  const holder = createServer((socket) => socket.destroy());
  holder.listen(0, '127.0.0.1');
  await once(holder, 'listening');
  try {
    const versionDir = join(dir, 'version');
    const stateDir = join(dir, 'state');
    await mkdir(versionDir);
    await mkdir(stateDir);
    await writeFile(join(versionDir, 'start.mjs'), APP);
    await writeFile(join(stateDir, 'data-key'), 'c3ludGhldGljLWtleS1mb3ItdGVzdHMtb25seS0wMDA=\n');
    await writeFile(join(stateDir, 'admin-password'), 'synthetic-admin-password\n');
    return await fn({ dir, versionDir, stateDir, taken: holder.address().port });
  } finally {
    holder.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('a port taken between its pick and the bind is picked again, and the boot succeeds', () =>
  withVersion(async ({ dir, versionDir, stateDir, taken }) => {
    const picked = [];
    const pickPort = async () => {
      const port = picked.length === 0 ? taken : await freePort();
      picked.push(port);
      return port;
    };
    const logFile = join(dir, 'boot.log');
    await bootCheck({ logFile, timeoutMs: 20_000, pickPort })({ versionDir, stateDir });
    assert.equal(picked.length, 2, `ports tried: ${picked.join(', ')}`);
    assert.equal(picked[0], taken);
    assert.match(await readFile(logFile, 'utf8'), /EADDRINUSE/);
  }));

test('a port that stays taken is tried a bounded number of times, then the boot fails', () =>
  withVersion(async ({ dir, versionDir, stateDir, taken }) => {
    let calls = 0;
    const pickPort = async () => {
      calls += 1;
      return taken;
    };
    await assert.rejects(
      bootCheck({ logFile: join(dir, 'boot.log'), timeoutMs: 20_000, pickPort })({
        versionDir,
        stateDir,
      }),
      /port .* in use/,
    );
    assert.equal(calls, 5);
  }));
