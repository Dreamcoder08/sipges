import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllEnvs());
it('rejects foreign hosts before serving the public shell or initializing SQL', async () => {
  vi.stubEnv('MASCLI_ALLOWED_HOSTS', 'demo.example.test');
  const { default: app } = await import('../src/index.ts');
  for (const path of ['/login', '/assets/example.js', '/health']) {
    const response = await app.request(`http://evil.example.test${path}`, {
      headers: { host: 'evil.example.test', accept: 'text/html' },
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Host no permitido');
  }
});
