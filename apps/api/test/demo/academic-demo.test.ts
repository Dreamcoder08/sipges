import { expect, test } from 'vitest';
import { IndicatorsReport } from '@mascli/contracts';
import { moduleForSlug, validatePayload } from '../../src/contexts/records/domain/modules.ts';
import { academicDemo } from '../../src/tools/academic-demo/dataset.ts';
import { planDemoImport } from '../../src/tools/academic-demo/plan.ts';
import {
  seedDemo,
  seedDemoEvidence,
  type DemoRequest,
} from '../../src/tools/academic-demo/seed.ts';
import { renderDemoEvidence } from '../../src/tools/academic-demo/documents.ts';
import { extractPdfText } from '../../src/contexts/documents/infrastructure/pdf-text.ts';
import { createTestApp } from '../support/test-app.ts';

test('academic demo has 122 valid, fictional records with complete source and actor references', () => {
  const data = academicDemo();
  expect(data.records).toHaveLength(122);
  expect(new Set(data.records.map((r) => r.module)).size).toBe(14);
  const keys = new Set(data.records.map((r) => r.key));
  expect(keys.size).toBe(122);
  for (const row of data.records) {
    expect(row.payload.Demo_Dataset).toBe('mascli-academic-v1');
    expect(row.payload.Dato_Sintetico).toBe(true);
    const module = moduleForSlug(row.module);
    if (!module) throw new Error('Unknown demo module');
    expect(validatePayload(module, row.payload)).toBeNull();
    for (const field of ['Fuente_ID', 'Actor_ID', 'Demanda_Asociada', 'Alerta_Asociada']) {
      const reference = row.payload[field];
      if (reference)
        expect(typeof reference === 'string' && keys.has(reference), `${row.key}: ${field}`).toBe(
          true,
        );
    }
  }
  expect(data.evidence).toHaveLength(10);
  for (const file of data.evidence) {
    expect(keys.has(file.recordId)).toBe(true);
    expect(file.text).toContain('SINTÉTICO');
  }
  expect(new Set(data.records.map((r) => r.payload.Escenario))).toEqual(
    new Set(['Acuerdo cumplido', 'Negociación abierta', 'Compromiso atrasado']),
  );
  expect(data.records.some((r) => r.payload.Estado === 'Cumplido')).toBe(true);
  expect(data.records.some((r) => r.payload.Estado === 'Vencido')).toBe(true);
});

test('demo import planning preserves existing edits and refuses reserved-id collisions before creating anything', () => {
  const data = academicDemo();
  const existing: Record<string, Record<string, unknown>[]> = {};
  for (const row of data.records)
    (existing[row.module] ??= []).push({
      ...row.payload,
      _id: row.key,
      Observaciones: 'User-edited record: preserve it.',
    });
  expect(planDemoImport(data, existing).create).toHaveLength(0);
  expect(planDemoImport(data, existing).skip).toHaveLength(122);
  expect(planDemoImport(data, {}).create).toHaveLength(122);
  expect(() =>
    planDemoImport(data, { fuentes: [{ _id: 'DEMO-F-01', Archivo_Fuente: 'User-owned record' }] }),
  ).toThrow(/collision/i);
  const first = existing.fuentes?.[0];
  if (!first) throw new Error('Missing source fixture');
  expect(() => planDemoImport(data, { fuentes: [first, first] })).toThrow(/duplicate/i);
});

test('the HTTP seeder defaults to dry run, persists usable records, and never duplicates a second import', async () => {
  const t = await createTestApp();
  const admin = await t.login('admin', 'admin-password-123');
  const request: DemoRequest = async (method, path, body) => {
    const response = await t.request(path, {
      method,
      headers: {
        cookie: admin.cookie,
        'X-MASCLI-Scope': 'MASCLI/PRJ-SECHURA',
        ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }),
      },
      ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
    });
    expect(response.status, path).toBe(200);
    return response.json();
  };
  expect(await seedDemo(request)).toMatchObject({ created: 0, pending: 122 });
  expect(await request('GET', '/api/eventos?limit=-1')).toHaveLength(0);
  expect(await seedDemo(request, true)).toMatchObject({ created: 122, skipped: 0 });
  expect(await seedDemo(request, true)).toMatchObject({ created: 0, skipped: 122 });
  expect(await seedDemoEvidence(request)).toEqual({ evidenceCreated: 10, evidenceSkipped: 0 });
  expect(await seedDemoEvidence(request)).toEqual({ evidenceCreated: 0, evidenceSkipped: 10 });
  expect(await request('GET', '/api/dashboard')).toMatchObject({
    eventos: 20,
    actores: 12,
    demandas_abiertas: 8,
    alertas_activas: 4,
    directorio: 12,
  });
  const indicators = IndicatorsReport.parse(await request('GET', '/system/indicators'));
  expect(indicators.indicators.some((i) => i.evidence_count > 0)).toBe(true);
});

test('demo evidence renders a parseable PDF and a real DOCX', async () => {
  const [pdfFile, docxFile] = academicDemo().evidence;
  if (!pdfFile || !docxFile) throw new Error('Missing document fixtures');
  const pdf = await renderDemoEvidence(pdfFile);
  const docx = await renderDemoEvidence(docxFile);
  expect(new TextDecoder().decode(pdf).startsWith('%PDF-')).toBe(true);
  expect(Array.from(docx.slice(0, 2))).toEqual([0x50, 0x4b]);
  const parsed = await extractPdfText(pdf, 5);
  expect(parsed.kind).toBe('pages');
  if (parsed.kind === 'pages') expect(parsed.pages.join(' ')).toContain('SINTETICO');
});

test('seeding fails closed when a list reaches the API cap and completeness cannot be proven', async () => {
  const request: DemoRequest = async (method, path) => {
    if (method !== 'GET') throw new Error('Unexpected write');
    if (path === '/system/auth/current-scope')
      return { scope: 'MASCLI/PRJ-SECHURA', company_id: 'MASCLI', project_id: 'PRJ-SECHURA' };
    return Array.from({ length: 500 }, (_, n) => ({ _id: `USER-${n}` }));
  };
  await expect(seedDemo(request, true)).rejects.toThrow(/complete|truncated/i);
});
