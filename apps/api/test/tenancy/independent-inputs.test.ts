import { expect, it } from 'vitest';
import { createTestApp } from '../support/test-app.ts';

type Fixture = Awaited<ReturnType<typeof createTestApp>>;

const snapshot = async (t: Fixture, cookie: string) => {
  const state = [];
  for (const path of [
    '/system/auth/accounts',
    '/system/auth/scopes',
    '/system/auth/current-scope',
    '/system/export',
  ]) {
    const res = await t.request(path, { headers: { cookie } });
    state.push({
      path,
      status: res.status,
      body: await res.text(),
      type: res.headers.get('content-type'),
      attachment: res.headers.get('content-disposition'),
      cache: res.headers.get('cache-control'),
      cookie: res.headers.get('set-cookie'),
    });
  }
  return state;
};

const grant = { username: 'admin', company_id: 'SIPGES', project_id: 'PRJ-SECHURA' };
const scope = {
  username: 'admin',
  company_id: 'ACME',
  project_id: 'NORTE',
  label: 'Synthetic',
};
const probes = [
  ...(['username', 'company_id', 'project_id'] as const).map((field) => ({
    path: '/system/auth/grants',
    field,
    body: { ...grant, [field]: `${grant[field]}\u0000` },
  })),
  ...(['username', 'label'] as const).map((field) => ({
    path: '/system/auth/scopes',
    field,
    body: { ...scope, [field]: `${scope[field]}\u0000` },
  })),
];

it.each(probes)('rejects NUL in $path $field without public state changes', async (probe) => {
  const t = await createTestApp();
  const admin = await t.login('admin', 'admin-password-123');
  expect(admin.res.status).toBe(200);
  const before = await snapshot(t, admin.cookie);
  const res = await t.request(probe.path, {
    method: 'POST',
    headers: { cookie: admin.cookie, 'content-type': 'application/json' },
    body: JSON.stringify(probe.body),
  });
  expect(await snapshot(t, admin.cookie)).toEqual(before);
  expect(res.status).toBe(422);
  expect(await res.json()).toEqual({
    detail: [{ type: 'custom', loc: ['body'], msg: 'Text must not contain NUL characters' }],
  });
  expect(res.headers.get('set-cookie')).toBeNull();
});

it('preserves valid scope creation, grant issuance and deletion', async () => {
  const t = await createTestApp();
  const admin = await t.login('admin', 'admin-password-123');
  expect(admin.res.status).toBe(200);
  const created = await t.createScope(admin.cookie, scope);
  expect(created.status).toBe(200);
  expect(await created.json()).toEqual({ ok: true, scope: 'ACME/NORTE' });
  const body = { username: 'admin', company_id: 'ACME', project_id: 'NORTE' };
  for (const method of ['POST', 'DELETE']) {
    const res = await t.request('/system/auth/grants', {
      method,
      headers: { cookie: admin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  }
  const scopes = await t.request('/system/auth/scopes', { headers: { cookie: admin.cookie } });
  expect(scopes.status).toBe(200);
  expect(await scopes.json()).toEqual([
    { company_id: 'SIPGES', project_id: 'PRJ-SECHURA', label: 'Proyecto Sechura (migración)' },
  ]);
});
