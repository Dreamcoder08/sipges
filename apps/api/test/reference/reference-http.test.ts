import { expect, it } from 'vitest';
import { ProjectCoordinatesResponse, CanonicalEntitiesResponse } from '@mascli/contracts';
import { createTestApp } from '../support/test-app.ts';

it('exposes reference geometry only for its registered company and project', async () => {
  const t = await createTestApp();
  const { cookie } = await t.login('admin', 'admin-password-123');
  const first = await t.request('/system/project-coordinates', { headers: { cookie } });
  expect(first.status).toBe(200);
  const body = ProjectCoordinatesResponse.parse(await first.json());
  expect(body.available).toBe(true);
  expect(body.data?.concessions).toHaveLength(5);
  expect(body.data?.crs.geometry).toBe('EPSG:4326');
  await t.createScope(cookie, {
    company_id: 'OTHER',
    project_id: 'PRJ-SECHURA',
    label: 'Other tenant',
    username: 'admin',
  });
  const second = await t.request('/system/project-coordinates', {
    headers: { cookie, 'X-MASCLI-Scope': 'OTHER/PRJ-SECHURA' },
  });
  expect(await second.json()).toMatchObject({ available: false, data: null });
  const canonical = await t.request('/system/canonical-entities', {
    headers: { cookie, 'X-MASCLI-Scope': 'MASCLI/PRJ-SECHURA' },
  });
  expect(
    CanonicalEntitiesResponse.parse(await canonical.json()).data?.CCSMS?.canonical_name,
  ).toContain('San Martín');
  const wrong = await t.request('/system/canonical-entities', {
    headers: { cookie, 'X-MASCLI-Scope': 'OTHER/PRJ-SECHURA' },
  });
  expect(await wrong.json()).toMatchObject({ available: false, data: null });
  expect((await t.request('/system/project-coordinates')).status).toBe(401);
});
