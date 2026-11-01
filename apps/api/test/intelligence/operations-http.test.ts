import { describe, expect, it } from 'vitest';
import type { EmbeddingProvider } from '../../src/contexts/intelligence/application/index.ts';
import { createOllamaEmbeddings } from '../../src/contexts/intelligence/infrastructure/index.ts';
import { createTestApp } from '../support/test-app.ts';

type Fixture = Awaited<ReturnType<typeof createTestApp>>;

const ALERT_TEXT =
  'Exigimos agua limpia: se rumorea que habrá paro y bloqueo este lunes. Convocatoria a asamblea.';

const setup = async (options: { embeddings?: EmbeddingProvider } = {}) => {
  const t = await createTestApp({}, options);
  const admin = await t.login('admin', 'admin-password-123');
  expect(admin.res.status).toBe(200);
  const call = (
    method: string,
    path: string,
    body?: unknown,
    extra: { cookie?: string; scope?: string } = {},
  ) =>
    t.request(path, {
      method,
      headers: {
        cookie: extra.cookie ?? admin.cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(extra.scope ? { 'x-sipges-scope': extra.scope } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async (res: Response) => (await res.json()) as Record<string, unknown>;
  return { t, admin, call, json };
};

const addUser = async (t: Fixture, adminCookie: string, role: string) => {
  const username = `user.${role}`;
  const res = await t.createAccount(adminCookie, {
    username,
    full_name: 'Synthetic',
    password: 'synthetic-pass-123',
    role,
  });
  expect(res.status).toBe(200);
  await t.grant(adminCookie, username);
  return (await t.login(username, 'synthetic-pass-123')).cookie;
};

/** Deterministic embeddings: the vector counts a few marker words. */
const fakeEmbeddings = (): EmbeddingProvider & { calls: string[] } => {
  const calls: string[] = [];
  const markers = [
    'agua',
    'paro',
    'empleo',
    'asamblea',
    'tierras',
    'accidente',
    'acuerdo',
    'marcha',
  ];
  return {
    model: 'fake-embed',
    calls,
    async embed(text) {
      calls.push(text);
      const lower = text.toLowerCase();
      return markers.map((m) => (lower.includes(m) ? 1 : 0.01));
    },
  };
};

describe('POST /system/analyze', () => {
  it('classifies a record payload and is open to read-only roles', async () => {
    const { t, admin, call, json } = await setup();
    const reader = await addUser(t, admin.cookie, 'consulta');
    const res = await call(
      'POST',
      '/system/analyze',
      { payload: { Texto: 'Demandas de empleo y proveedores' } },
      { cookie: reader },
    );
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      dimension: 'D',
      classifier_version: '0.5.1-calibracion',
    });
    expect((await call('POST', '/system/analyze', { payload: 'x' })).status).toBe(422);
  });
});

describe('text and semantic analysis', () => {
  it('analyzes text with the error codes of app.py', async () => {
    const { call, json } = await setup();
    const ok = await call('POST', '/system/intelligence/analyze-text', { text: ALERT_TEXT });
    expect(ok.status).toBe(200);
    expect(await json(ok)).toMatchObject({ version: '2.4', project_id: 'PRJ-SECHURA' });
    const empty = await call('POST', '/system/intelligence/analyze-text', { text: '  ' });
    expect(empty.status).toBe(422);
    const long = await call('POST', '/system/intelligence/analyze-text', {
      text: 'a'.repeat(20_001),
    });
    expect(long.status).toBe(413);
    const foreign = await call('POST', '/system/intelligence/analyze-text', {
      text: ALERT_TEXT,
      project_id: 'OTRO',
    });
    expect(foreign.status).toBe(403);
  });

  it('falls back to rules when the model is offline and answers 503 in semantic mode', async () => {
    const { call, json } = await setup();
    const auto = await json(
      await call('POST', '/system/intelligence/semantic-analyze', { text: ALERT_TEXT }),
    );
    expect(auto).toMatchObject({
      version: '2.5',
      source_retrieved: false,
      semantic: { active: false },
    });
    expect((auto.semantic as { note: string }).note).toContain('Ollama local no disponible');
    const strict = await call('POST', '/system/intelligence/semantic-analyze', {
      text: ALERT_TEXT,
      mode: 'semantic',
    });
    expect(strict.status).toBe(503);
    expect(
      (await call('POST', '/system/intelligence/semantic-analyze', { text: 'x', mode: 'ia' }))
        .status,
    ).toBe(422);
    const badUrl = await call('POST', '/system/intelligence/semantic-analyze', {
      text: ALERT_TEXT,
      source_url: 'file:///etc/passwd',
    });
    expect(badUrl.status).toBe(422);
  });

  it('ranks reference themes by cosine similarity and embeds each concept once', async () => {
    const embeddings = fakeEmbeddings();
    const { call, json } = await setup({ embeddings });
    const body = await json(
      await call('POST', '/system/intelligence/semantic-analyze', { text: ALERT_TEXT }),
    );
    const semantic = body.semantic as {
      active: boolean;
      model: string;
      matches: { theme: string; similarity: number }[];
    };
    expect(semantic.active).toBe(true);
    expect(semantic.model).toBe('fake-embed');
    expect(semantic.matches.length).toBeGreaterThan(0);
    const sims = semantic.matches.map((m) => m.similarity);
    expect([...sims].sort((a, b) => b - a)).toEqual(sims);
    expect(body.method).toContain('Análisis híbrido');
    await call('POST', '/system/intelligence/semantic-analyze', { text: ALERT_TEXT });
    // 1 content + 7 concepts, then only the content again.
    expect(embeddings.calls).toHaveLength(9);
  });
});

describe('territorial alerts and preventive plans', () => {
  it('runs the alert inbox, plan lifecycle and management report end to end', async () => {
    const { t, admin, call, json } = await setup();
    const coordinator = await addUser(t, admin.cookie, 'coordinador');
    const reader = await addUser(t, admin.cookie, 'consulta');

    const created = await call(
      'POST',
      '/system/intelligence/territorial-alerts',
      { text: ALERT_TEXT, source_url: 'https://example.org/post', mode: 'rules' },
      { cookie: coordinator },
    );
    expect(created.status).toBe(200);
    const alert = await json(created);
    expect(alert).toMatchObject({ status: 'Pendiente de verificación', irsa_modified: false });
    const alertId = String(alert.id);
    expect(alertId).toMatch(/^DIG-[0-9A-F]{12}$/);

    expect(
      (
        await call('POST', '/system/intelligence/territorial-alerts', {
          text: ALERT_TEXT,
          source_type: 'Rumor',
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call(
          'POST',
          '/system/intelligence/territorial-alerts',
          { text: 'x' },
          { cookie: reader },
        )
      ).status,
    ).toBe(403);

    const plan = {
      alert_id: alertId,
      title: 'Mesa técnica de agua',
      responsible: 'Equipo social',
      due_date: '2026-10-01',
    };
    const early = await call('POST', '/system/prevention/actions', plan);
    expect(early.status).toBe(409);

    const badDecision = await call('PATCH', `/system/intelligence/territorial-alerts/${alertId}`, {
      status: 'Aprobado',
    });
    expect(badDecision.status).toBe(422);
    expect(
      (
        await call('PATCH', '/system/intelligence/territorial-alerts/DIG-NOPE', {
          status: 'Corroborado',
        })
      ).status,
    ).toBe(404);
    const decided = await call(
      'PATCH',
      `/system/intelligence/territorial-alerts/${alertId}`,
      { status: 'Corroborado', reviewer_note: 'Contrastado con acta' },
      { cookie: coordinator },
    );
    // The alert is high priority: the first validation waits for a second person.
    expect(await json(decided)).toMatchObject({
      ok: true,
      status: 'Pendiente de verificación',
      second_validation_required: true,
      irsa_modified: false,
    });
    const confirmed = await call('PATCH', `/system/intelligence/territorial-alerts/${alertId}`, {
      status: 'Corroborado',
      reviewer_note: 'Contrastado con acta',
    });
    expect(await json(confirmed)).toMatchObject({
      ok: true,
      status: 'Corroborado',
      irsa_modified: false,
    });

    const list = (await (
      await call('GET', '/system/intelligence/territorial-alerts')
    ).json()) as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: alertId,
      status: 'Corroborado',
      reviewer_note: 'Contrastado con acta',
      reviewed_at: '2026-10-12T12:00:00Z',
      semantic_active: false,
      source_url: 'https://example.org/post',
    });
    const summary = await json(await call('GET', '/system/intelligence/territorial-summary'));
    expect(summary).toMatchObject({ total: 1, by_status: { Corroborado: 1 } });

    expect(
      (await call('POST', '/system/prevention/actions', { ...plan, alert_id: 'DIG-NOPE' })).status,
    ).toBe(404);
    expect(
      (await call('POST', '/system/prevention/actions', { ...plan, due_date: '2026-02-30' }))
        .status,
    ).toBe(422);
    expect((await call('POST', '/system/prevention/actions', { ...plan, title: 'x' })).status).toBe(
      422,
    );
    const action = await json(
      await call('POST', '/system/prevention/actions', plan, { cookie: coordinator }),
    );
    const actionId = String((action.action as { id: string }).id);
    expect(action.action).toMatchObject({
      status: 'Pendiente',
      progress: 0,
      due_date: '2026-10-01',
      history: [{ status: 'Pendiente', note: 'Plan creado', evidence_url: null }],
    });

    const update = (body: unknown) => call('PATCH', `/system/prevention/actions/${actionId}`, body);
    const cases: [unknown, number][] = [
      [{ status: 'Hecha', progress: 0 }, 422],
      [{ status: 'Completada', progress: 90, note: 'x' }, 422],
      [{ status: 'Pendiente', progress: 10 }, 422],
      [{ status: 'En ejecución', progress: 10, evidence_url: 'ftp://x' }, 422],
      [{ status: 'Completada', progress: 100 }, 422],
      [{ status: 'En ejecución', progress: 101 }, 422],
    ];
    for (const [body, status] of cases)
      expect((await update(body)).status, JSON.stringify(body)).toBe(status);
    expect(
      (
        await call('PATCH', '/system/prevention/actions/PREV-NOPE', {
          status: 'En ejecución',
          progress: 5,
        })
      ).status,
    ).toBe(404);
    const progressed = await json(
      await update({
        status: 'En ejecución',
        progress: 40,
        note: 'Avance',
        evidence_url: 'https://example.org/acta',
      }),
    );
    expect((progressed.action as { history: unknown[] }).history).toHaveLength(2);

    const prevention = await json(await call('GET', '/system/prevention/summary'));
    expect(prevention).toMatchObject({ total: 1, active: 1, overdue: 1, average_progress: 40 });

    const overview = await json(await call('GET', '/system/management/overview'));
    expect(overview).toMatchObject({
      version: '2.8',
      metrics: { digital_alerts: 1, high_priority_alerts: 1, overdue_actions: 1, total_actions: 1 },
      actions_by_responsible: [{ name: 'Equipo social', total: 1, overdue: 1 }],
    });
    const csv = await call('GET', '/system/management/report.csv', undefined, { cookie: reader });
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(csv.headers.get('content-disposition')).toBe(
      'attachment; filename="sipges_rc28_reporte_gerencial.csv"',
    );
    const bytes = new Uint8Array(await csv.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes)).toContain(
      'Mesa técnica de agua,Equipo social,2026-10-01,En ejecución,40',
    );

    const cancelled = await update({ status: 'Cancelada', progress: 40, note: 'Sin presupuesto' });
    expect(cancelled.status).toBe(200);
    expect((await update({ status: 'En ejecución', progress: 50 })).status).toBe(409);

    const audit = (await (await call('GET', '/system/audit')).json()) as {
      module: string;
      action: string;
    }[];
    expect(audit.map((a) => `${a.module}:${a.action}`)).toEqual([
      'PrevencionTerritorial:UPDATE',
      'PrevencionTerritorial:UPDATE',
      'PrevencionTerritorial:CREATE',
      'InteligenciaDigital:REVIEW',
      'InteligenciaDigital:REVIEW',
      'InteligenciaDigital:CREATE',
    ]);

    const exported = (await (await call('GET', '/system/export')).json()) as {
      data: Record<string, unknown[]>;
    };
    expect(exported.data.digital_alert_reviews).toHaveLength(1);
    expect(exported.data.preventive_actions).toHaveLength(1);
    expect(exported.data.preventive_action_log).toHaveLength(3);

    expect(
      (
        await t.createScope(admin.cookie, {
          company_id: 'ACME',
          project_id: 'NORTE',
          label: 'Norte',
          username: 'admin',
        })
      ).status,
    ).toBe(200);
    const north = { scope: 'ACME/NORTE' };
    expect(
      await (await call('GET', '/system/intelligence/territorial-alerts', undefined, north)).json(),
    ).toEqual([]);
    expect(
      await (await call('GET', '/system/prevention/actions', undefined, north)).json(),
    ).toEqual([]);
    expect((await call('POST', '/system/prevention/actions', plan, north)).status).toBe(404);
    expect(
      (
        await call(
          'PATCH',
          `/system/prevention/actions/${actionId}`,
          { status: 'Cancelada', progress: 0, note: 'x' },
          north,
        )
      ).status,
    ).toBe(404);
  });
});

describe('Ollama embeddings adapter', () => {
  it('posts to the configured /api/embed and validates the vector', async () => {
    const requests: { url: string; body: unknown }[] = [];
    const respond = (payload: unknown, status = 200) =>
      (async (url: URL | Request | string, init?: RequestInit) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify(payload), { status });
      }) as typeof fetch;
    const ok = createOllamaEmbeddings({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'nomic-embed-text',
      fetch: respond({ embeddings: [[1, 2, 3, 4, 5, 6, 7, 8]] }),
    });
    expect(await ok.embed('hola')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(requests[0]).toEqual({
      url: 'http://127.0.0.1:11434/api/embed',
      body: { model: 'nomic-embed-text', input: 'hola' },
    });
    const short = createOllamaEmbeddings({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'm',
      fetch: respond({ embeddings: [[1, 2]] }),
    });
    await expect(short.embed('x')).rejects.toThrow();
    const failing = createOllamaEmbeddings({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'm',
      fetch: respond({}, 500),
    });
    await expect(failing.embed('x')).rejects.toThrow();
  });
});

describe('documented digital provenance and retry safety', () => {
  it('deduplicates concurrent evidence, preserves reviewed status and immutable audit snapshots', async () => {
    const { t, call, json } = await setup();
    const body = {
      text: ALERT_TEXT,
      mode: 'rules',
      source_url: 'https://example.org/synthetic-evidence',
      territory: 'Synthetic documented territory',
    };
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        call('POST', '/system/intelligence/territorial-alerts', body),
      ),
    );
    const results = await Promise.all(responses.map(json));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => r.outcome === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'duplicate')).toHaveLength(3);
    const id = results[0]?.id;
    // High priority: two different people validate it.
    const second = await addUser(
      t,
      (await t.login('admin', 'admin-password-123')).cookie,
      'coordinador',
    );
    const review = (cookie?: string) =>
      call(
        'PATCH',
        `/system/intelligence/territorial-alerts/${id}`,
        { status: 'Corroborado', reviewer_note: 'Synthetic review' },
        cookie ? { cookie } : {},
      );
    expect((await review()).status).toBe(200);
    expect((await review(second)).status).toBe(200);
    const retry = await (
      await call('POST', '/system/intelligence/territorial-alerts', body)
    ).json();
    expect(retry).toMatchObject({ id, status: 'Corroborado', outcome: 'duplicate' });
    const snapshots = await t.sql.query<{ action: string; event_payload: Record<string, unknown> }>(
      "SELECT action, event_payload FROM audit WHERE module = 'InteligenciaDigital' ORDER BY id",
    );
    expect(snapshots).toHaveLength(3);
    expect(snapshots[0]).toMatchObject({
      action: 'CREATE',
      event_payload: {
        id,
        status: 'Pendiente de verificación',
        territory: body.territory,
        source_url: body.source_url,
        project_id: 'PRJ-SECHURA',
        source_record: null,
      },
    });
    expect(snapshots[1]).toMatchObject({
      action: 'REVIEW',
      event_payload: { id, status: 'Pendiente de verificación', territory: body.territory },
    });
    expect(snapshots[2]).toMatchObject({
      action: 'REVIEW',
      event_payload: { id, status: 'Corroborado', territory: body.territory },
    });
    const list = (await (
      await call('GET', '/system/intelligence/territorial-alerts')
    ).json()) as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      territory: body.territory,
      source_record: null,
      reviewer_note: 'Synthetic review',
    });
    const other = await json(
      await call('POST', '/system/intelligence/territorial-alerts', {
        ...body,
        territory: 'Different documented territory',
      }),
    );
    expect(other.id).not.toBe(id);
    t.clock.advance(24 * 60 * 60 + 1);
    const fresh = await t.login('admin', 'admin-password-123');
    const nextDay = await json(
      await call('POST', '/system/intelligence/territorial-alerts', body, { cookie: fresh.cookie }),
    );
    expect(nextDay.outcome).toBe('created');
    expect(nextDay.id).not.toBe(id);
  });
});
