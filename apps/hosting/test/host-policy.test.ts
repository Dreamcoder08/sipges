import { afterEach, expect, it, vi } from 'vitest';

// Isolate the host guard from external SQL/Blob initialization; assert HTTP behavior.
vi.mock('../src/lazy-app.ts', async () => {
  const { Hono } = await import('hono');
  return { createHostedApp: () => new Hono().get('/health', (c) => c.json({ ok: true })) };
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it('accepts the exact Vercel branch and deployment hosts while rejecting unrelated hosts', async () => {
  vi.stubEnv('SIPGES_ALLOWED_HOSTS', undefined);
  vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', 'project.vercel.app');
  vi.stubEnv('VERCEL_URL', 'deployment-123.vercel.app');
  vi.stubEnv('VERCEL_BRANCH_URL', 'project-git-feature-team.vercel.app');
  const { default: app } = await import('../src/index.ts');
  for (const host of ['project-git-feature-team.vercel.app', 'deployment-123.vercel.app']) {
    expect((await app.request(`https://${host}/health`, { headers: { host } })).status).toBe(200);
  }
  const host = 'unrelated.vercel.app';
  expect((await app.request(`https://${host}/health`, { headers: { host } })).status).toBe(400);
});

it('preserves an explicit allowlist even when Vercel supplies a branch alias', async () => {
  vi.stubEnv('SIPGES_ALLOWED_HOSTS', 'locked.example.test');
  vi.stubEnv('VERCEL_BRANCH_URL', 'project-git-feature-team.vercel.app');
  const { default: app } = await import('../src/index.ts');
  for (const [host, status] of [
    ['locked.example.test', 200],
    ['project-git-feature-team.vercel.app', 400],
  ] as const) {
    expect((await app.request(`https://${host}/health`, { headers: { host } })).status).toBe(
      status,
    );
  }
});
it('rejects foreign hosts before serving the public shell or initializing SQL', async () => {
  vi.stubEnv('SIPGES_ALLOWED_HOSTS', 'demo.example.test');
  const { default: app } = await import('../src/index.ts');
  for (const path of ['/login', '/assets/example.js', '/health']) {
    const response = await app.request(`http://evil.example.test${path}`, {
      headers: { host: 'evil.example.test', accept: 'text/html' },
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Host no permitido');
  }
});
