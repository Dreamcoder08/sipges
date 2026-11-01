import { expect, it, vi } from 'vitest';
import { createTestApp } from '../support/test-app.ts';
it('bounds source and geography requests before tenancy parses JSON and preserves its scoped body cache', async () => {
  const t = await createTestApp();
  const admin = await t.login('admin', 'admin-password-123');
  const headers = {
    cookie: admin.cookie,
    'content-type': 'application/json',
    'x-sipges-scope': 'SIPGES/PRJ-SECHURA',
  };
  const query = vi.spyOn(t.container.geography, 'query').mockResolvedValue({
    features: [],
    truncated: false,
    source: 'Controlled test provider',
    related: [],
    unlocated: [],
  });
  const response = await t.request('/system/geography/query', {
    method: 'POST',
    headers,
    body: JSON.stringify({ layerId: 0, bbox: [0, 0, 1, 1] }),
  });
  expect(response.status).toBe(200);
  expect(query).toHaveBeenCalledWith(
    expect.objectContaining({ companyId: 'SIPGES', projectId: 'PRJ-SECHURA' }),
    expect.objectContaining({ layerId: 0 }),
  );
  const config = await t.request('/system/intelligence/sources/defensoria/config', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ enabled: false, query: 'agua', territory: '', authorization_note: '' }),
  });
  expect(config.status).toBe(200);
  expect(await config.json()).toMatchObject({ enabled: false, query: 'agua' });
  for (const [path, limit] of [
    ['/system/geography/query', 100001],
    ['/system/intelligence/sources/defensoria/config', 8193],
  ] as const) {
    const oversized = await t.request(path, {
      method: path.endsWith('config') ? 'PUT' : 'POST',
      headers,
      body: ' '.repeat(limit),
    });
    expect(oversized.status).toBe(413);
  }
  expect(query).toHaveBeenCalledTimes(1);
}, 60000);
