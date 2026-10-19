import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { ProjectSettingsProvider } from '../../shared/lib/project-settings.tsx';
import { server } from '../../test/server.ts';
import { IntelligencePage } from './IntelligencePage.tsx';
import { ManagementPage } from './ManagementPage.tsx';
vi.mock('./AuthorizedSourcesCard.tsx', () => ({ AuthorizedSourcesCard: () => null }));
const context = {
  scope: 'DEMO/PRJ-DEMO',
  projectId: 'PRJ-DEMO',
  projectLabel: 'Demo',
  role: 'consulta' as const,
  username: 'reader',
  fullName: 'Reader',
};
const mount = (page: React.ReactNode) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      {page}
    </QueryClientProvider>,
  );
describe('operational pages', () => {
  it('allows scoped read-only analysis and explains automatic fallback without write controls', async () => {
    let sent: unknown;
    server.use(
      http.get('*/system/intelligence/territorial-alerts', () => HttpResponse.json([])),
      http.get('*/system/intelligence/territorial-summary', () =>
        HttpResponse.json({
          version: '2.6',
          project_id: 'PRJ-DEMO',
          total: 0,
          by_status: {},
          by_priority: {},
          themes: [],
          irsa_integration: 'Sin modificación automática',
          caution: 'Revisión humana',
        }),
      ),
      http.post('*/system/intelligence/semantic-analyze', async ({ request }) => {
        expect(request.headers.get('X-MASCLI-Scope')).toBe(context.scope);
        sent = await request.json();
        return HttpResponse.json({
          version: '2.5',
          project_id: 'PRJ-DEMO',
          source_url: '',
          analyzed_chars: 20,
          topics: [],
          signals: [],
          orientation: { score: 0, level: 'Baja', meaning: 'Prioridad textual' },
          project_comparison: [],
          suggested_actions: ['Verificar'],
          evidence: { fragment: 'Texto', sha256: 'abc' },
          method: 'Reglas',
          limitations: ['Revisión humana'],
          semantic: {
            active: false,
            method: 'rules',
            matches: [],
            note: 'Modelo no disponible; análisis por reglas',
          },
          verification_status: 'Pendiente',
          source_retrieved: false,
        });
      }),
    );
    mount(<IntelligencePage {...context} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Texto a analizar'), 'Publicación sobre agua');
    await user.click(screen.getByRole('button', { name: 'Analizar texto' }));
    expect(await screen.findByText(/Modelo no disponible; análisis por reglas/)).toBeVisible();
    expect(sent).toMatchObject({
      text: 'Publicación sobre agua',
      mode: 'automatic',
      project_id: 'PRJ-DEMO',
    });
    expect(screen.queryByRole('button', { name: 'Registrar alerta' })).toBeNull();
  });
  it('shows management error instead of inventing metrics', async () => {
    server.use(
      http.get('*/system/management/overview', () =>
        HttpResponse.json({ detail: 'Proyecto sin acceso' }, { status: 403 }),
      ),
    );
    server.use(
      http.get('*/system/prevention/actions', () => HttpResponse.json([])),
      http.get('*/system/prevention/summary', () =>
        HttpResponse.json({
          project_id: 'PRJ-DEMO',
          total: 0,
          active: 0,
          overdue: 0,
          completed: 0,
          completion_percent: 0,
          average_progress: 0,
          irsa_modified: false,
          notice: 'Operativo',
        }),
      ),
      http.get('*/system/intelligence/territorial-alerts', () => HttpResponse.json([])),
    );
    mount(<ManagementPage {...context} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Proyecto sin acceso');
  });
});
const alertFixture = (id: string, status: string) => ({
  id,
  project_id: 'PRJ-DEMO',
  created_at: '2026-10-13T00:00:00Z',
  source_url: 'https://example.test/source',
  source_type: 'Documento',
  excerpt: `Publicación ${id}`,
  sha256: 'abc',
  level: 'Media',
  score: 35,
  method: 'Reglas',
  semantic_active: false,
  status,
  analyst_note: 'Fuente sintética',
  reviewer_note: null,
  reviewed_at: null,
  themes: [],
  signals: [],
  suggestions: [],
});
const actionFixture = {
  id: 'action-1',
  project_id: 'PRJ-DEMO',
  alert_id: 'verified',
  title: 'Plan preventivo sintético',
  responsible: 'Equipo Demo',
  due_date: '2026-10-20',
  description: 'Reunión local',
  status: 'En ejecución',
  progress: 20,
  created_at: '2026-10-13T00:00:00Z',
  updated_at: '2026-10-13T00:00:00Z',
  history: [
    {
      id: 'log-1',
      action_id: 'action-1',
      created_at: '2026-10-13T00:00:00Z',
      status: 'En ejecución',
      progress: 20,
      note: 'Reunión registrada',
      evidence_url: null,
    },
  ],
};
const overviewFixture = {
  version: '2.8',
  project_id: 'PRJ-DEMO',
  generated_at: '2026-10-13T00:00:00Z',
  metrics: {
    digital_alerts: 2,
    high_priority_alerts: 0,
    pending_review: 1,
    total_actions: 1,
    active_actions: 1,
    overdue_actions: 0,
    completed_actions: 0,
    completion_percent: 0,
    average_progress: 20,
    registered_commitments: 0,
    overdue_commitments_explicit: 0,
  },
  alerts_by_level: { Media: 2 },
  actions_by_status: { 'En ejecución': 1 },
  actions_by_responsible: [],
  critical_actions: [],
  recent_alerts: [],
  commitments: [],
  methodology: 'Descriptivo',
  limitations: ['IRSA independiente'],
};
const installManagement = () =>
  server.use(
    http.get('*/system/management/overview', () => HttpResponse.json(overviewFixture)),
    http.get('*/system/prevention/actions', () => HttpResponse.json([actionFixture])),
    http.get('*/system/prevention/summary', () =>
      HttpResponse.json({
        project_id: 'PRJ-DEMO',
        total: 1,
        active: 1,
        overdue: 0,
        completed: 0,
        completion_percent: 0,
        average_progress: 20,
        irsa_modified: false,
        notice: 'Operativo',
      }),
    ),
    http.get('*/system/intelligence/territorial-alerts', () =>
      HttpResponse.json([
        alertFixture('unverified', 'Pendiente de verificación'),
        alertFixture('verified', 'Corroborado'),
      ]),
    ),
  );
it('coordinador creates plans only from verified alerts and saves scoped transitions with history', async () => {
  installManagement();
  let created: unknown;
  let updated: unknown;
  server.use(
    http.post('*/system/prevention/actions', async ({ request }) => {
      expect(request.headers.get('X-MASCLI-Scope')).toBe(context.scope);
      created = await request.json();
      return HttpResponse.json({ action: actionFixture, irsa_modified: false });
    }),
    http.patch('*/system/prevention/actions/action-1', async ({ request }) => {
      expect(request.headers.get('X-MASCLI-Scope')).toBe(context.scope);
      updated = await request.json();
      return HttpResponse.json({
        action: { ...actionFixture, status: 'Completada', progress: 100 },
        irsa_modified: false,
      });
    }),
  );
  mount(<ManagementPage {...context} role="coordinador" />);
  const user = userEvent.setup();
  const select = await screen.findByLabelText('Alerta verificada');
  expect(screen.queryByRole('option', { name: /unverified/ })).toBeNull();
  await user.selectOptions(select, 'verified');
  await user.type(screen.getByLabelText('Título del plan'), 'Plan sintético');
  await user.type(screen.getByLabelText('Responsable'), 'Equipo Demo');
  await user.type(screen.getByLabelText('Fecha de vencimiento'), '2026-10-20');
  await user.click(screen.getByRole('button', { name: 'Crear plan' }));
  expect(await screen.findByText('Plan preventivo creado; no modifica el IRSA.')).toBeVisible();
  expect(created).toMatchObject({ alert_id: 'verified', project_id: 'PRJ-DEMO' });
  await user.click(screen.getByRole('button', { name: 'Ver plan action-1' }));
  expect(screen.getByText(/Reunión registrada/)).toBeVisible();
  await user.selectOptions(screen.getByLabelText('Estado del plan'), 'Completada');
  expect(screen.getByRole('button', { name: 'Guardar avance' })).toBeDisabled();
  await user.type(screen.getByLabelText('Nota de avance'), 'Revisión final documentada');
  await user.click(screen.getByRole('button', { name: 'Guardar avance' }));
  expect(await screen.findByText('Avance registrado; no modifica el IRSA.')).toBeVisible();
  expect(updated).toMatchObject({
    status: 'Completada',
    progress: 100,
    note: 'Revisión final documentada',
  });
});
it('consulta sees prevention history without write forms', async () => {
  installManagement();
  mount(<ManagementPage {...context} />);
  await screen.findByText('Plan preventivo sintético');
  expect(screen.queryByRole('button', { name: 'Crear plan' })).toBeNull();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Ver plan action-1' }));
  expect(screen.getByText(/Reunión registrada/)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Guardar avance' })).toBeNull();
});
it('reports unavailable semantic models without registering an alert', async () => {
  server.use(
    http.get('*/system/intelligence/territorial-alerts', () => HttpResponse.json([])),
    http.get('*/system/intelligence/territorial-summary', () =>
      HttpResponse.json({
        version: '2.6',
        project_id: 'PRJ-DEMO',
        total: 0,
        by_status: {},
        by_priority: {},
        themes: [],
        irsa_integration: 'Independiente',
        caution: 'Humana',
      }),
    ),
    http.post('*/system/intelligence/semantic-analyze', () =>
      HttpResponse.json({ detail: 'Modelo local no disponible' }, { status: 503 }),
    ),
  );
  mount(<IntelligencePage {...context} />);
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Texto a analizar'), 'Texto sintético');
  await user.selectOptions(screen.getByLabelText('Modo de análisis'), 'semantic');
  await user.click(screen.getByRole('button', { name: 'Analizar texto' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Modelo local no disponible');
  expect(screen.queryByText('Resultado orientativo')).toBeNull();
});
it('reviews a territorial alert in active scope and preserves the IRSA separation', async () => {
  let body: unknown;
  server.use(
    http.get('*/system/intelligence/territorial-alerts', () =>
      HttpResponse.json([alertFixture('review-me', 'Pendiente de verificación')]),
    ),
    http.get('*/system/intelligence/territorial-summary', () =>
      HttpResponse.json({
        version: '2.6',
        project_id: 'PRJ-DEMO',
        total: 1,
        by_status: { 'Pendiente de verificación': 1 },
        by_priority: { Media: 1 },
        themes: [],
        irsa_integration: 'Sin modificación automática',
        caution: 'Revisión humana',
      }),
    ),
    http.patch('*/system/intelligence/territorial-alerts/review-me', async ({ request }) => {
      expect(request.headers.get('X-MASCLI-Scope')).toBe(context.scope);
      body = await request.json();
      return HttpResponse.json({
        ok: true,
        status: 'Corroborado',
        irsa_modified: false,
        notice: 'La validación NO cambia el IRSA.',
      });
    }),
  );
  mount(<IntelligencePage {...context} role="analista" />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ver alerta review-me' }));
  await user.selectOptions(screen.getByLabelText('Estado de revisión'), 'Corroborado');
  await user.type(
    screen.getByLabelText('Nota de revisión humana'),
    'Confirmado con fuente primaria sintética',
  );
  await user.click(screen.getByRole('button', { name: 'Guardar revisión' }));
  expect(await screen.findByText('La validación NO cambia el IRSA.')).toBeVisible();
  expect(body).toEqual({
    status: 'Corroborado',
    reviewer_note: 'Confirmado con fuente primaria sintética',
  });
});
it('keeps cancelled plans cancelled and requires a note even for an unchanged cancellation', async () => {
  installManagement();
  server.use(
    http.get('*/system/prevention/actions', () =>
      HttpResponse.json([{ ...actionFixture, status: 'Cancelada', progress: 20 }]),
    ),
  );
  mount(<ManagementPage {...context} role="admin" />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ver plan action-1' }));
  expect(screen.getByRole('option', { name: 'En ejecución' })).toBeDisabled();
  expect(screen.getByRole('option', { name: 'Completada' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Guardar avance' })).toBeDisabled();
  expect(screen.getByText('Justifique el cierre o cancelación.')).toBeVisible();
});

it('opens notification deep links with documented territory and source provenance', async () => {
  window.history.replaceState({}, '', '/intelligence?alert=DIG-LINK');
  const linked = {
    ...alertFixture('DIG-LINK', 'Corroborado'),
    territory: 'Territorio documentado',
    source_record: { module: 'Narrativas', id: 'NAR-SYNTHETIC' },
  };
  server.use(
    http.get('*/system/intelligence/territorial-alerts', () => HttpResponse.json([linked])),
    http.get('*/system/intelligence/territorial-alerts/DIG-LINK', () => HttpResponse.json(linked)),
    http.get('*/system/intelligence/territorial-summary', () =>
      HttpResponse.json({
        version: '2.6',
        project_id: 'PRJ-DEMO',
        total: 1,
        by_status: {},
        by_priority: {},
        themes: [],
        irsa_integration: 'IRSA independiente',
        caution: 'Revisión humana',
      }),
    ),
  );
  mount(<IntelligencePage {...context} role="coordinador" />);
  expect(await screen.findByRole('heading', { name: 'Alerta DIG-LINK' })).toBeVisible();
  expect(screen.getByText('Territorio: Territorio documentado')).toBeVisible();
  expect(screen.getByText(/NAR-SYNTHETIC/)).toBeVisible();
  expect(screen.getByLabelText('Estado de revisión')).toHaveValue('Corroborado');
  expect(screen.getByLabelText('Territorio documentado')).toBeVisible();
  window.history.replaceState({}, '', '/');
});

const version4Settings = {
  version4: true,
  level_meanings: {
    Verde: 'Situación estable / riesgo bajo',
    Amarillo: 'Requiere atención y seguimiento',
    Naranja: 'Requiere intervención preventiva',
    Rojo: 'Situación crítica / atención inmediata',
  },
  window_days: 90,
  half_life_days: 14,
  thresholds: { Amarillo: 2, Naranja: 4, Rojo: 7 },
  recommendations: [],
  updated_by: 'admin',
  updated_at: '2026-10-19T12:00:00Z',
};
const SHA = '7a0610ad8ab6ac06e61aa4e05ea56a8bf5d85a6b6d419cd756c56d5321a78aee';
it('with MASCLI 4.0 a plan closes with an attached evidence file and shows its receipt', async () => {
  installManagement();
  let updated: unknown;
  let stored: unknown = actionFixture;
  server.use(
    http.get('*/system/prevention/actions', () => HttpResponse.json([stored])),
    http.get('*/system/uploads', () =>
      HttpResponse.json([
        {
          id: 'ADJ-1',
          original_name: 'acta-cierre.pdf',
          content_type: 'application/pdf',
          size_bytes: 10,
          sha256: SHA,
          linked_module: 'eventos',
          linked_record_id: 'EV-1',
          document_type: 'Acta',
          author: '',
          verification: 'A',
          notes: '',
          project_id: 'PRJ-DEMO',
          project_name: 'Demo',
          created_at: '2026-10-19T12:00:00Z',
        },
      ]),
    ),
    http.patch('*/system/prevention/actions/action-1', async ({ request }) => {
      updated = await request.json();
      const closing = {
        id: 'log-2',
        action_id: 'action-1',
        created_at: '2026-10-19T12:00:00Z',
        status: 'Completada',
        progress: 100,
        note: 'Acuerdo firmado',
        evidence_url: null,
        receipt: {
          attachment_id: 'ADJ-1',
          file_name: 'acta-cierre.pdf',
          sha256: SHA,
          decided_by: 'coord',
        },
      };
      stored = {
        ...actionFixture,
        status: 'Completada',
        progress: 100,
        history: [closing, ...actionFixture.history],
      };
      return HttpResponse.json({ action: stored, irsa_modified: false });
    }),
  );
  mount(
    <ProjectSettingsProvider value={version4Settings}>
      <ManagementPage {...context} role="coordinador" />
    </ProjectSettingsProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ver plan action-1' }));
  await user.selectOptions(screen.getByLabelText('Estado del plan'), 'Completada');
  await user.type(screen.getByLabelText('Nota de avance'), 'Acuerdo firmado');
  expect(
    screen.getByText('Adjunte la evidencia que respalda el cierre de la acción.'),
  ).toBeVisible();
  expect(screen.getByRole('button', { name: 'Guardar avance' })).toBeDisabled();
  await user.selectOptions(await screen.findByLabelText('Evidencia adjunta (recibo)'), 'ADJ-1');
  await user.click(screen.getByRole('button', { name: 'Guardar avance' }));
  expect(await screen.findByText('Avance registrado; no modifica el IRSA.')).toBeVisible();
  expect(updated).toMatchObject({ status: 'Completada', evidence_attachment_id: 'ADJ-1' });
  expect(
    await screen.findByText(
      `Recibo: acta-cierre.pdf · sha256 ${SHA.slice(0, 12)}… · decidió coord`,
    ),
  ).toBeVisible();
});
it('MASCLI 3.0 keeps the evidence URL form without receipts', async () => {
  installManagement();
  mount(<ManagementPage {...context} role="coordinador" />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ver plan action-1' }));
  expect(screen.getByLabelText('URL de evidencia')).toBeVisible();
  expect(screen.queryByLabelText('Evidencia adjunta (recibo)')).toBeNull();
});
it('MASCLI 4.0 shows that a high-priority alert waits for a second person', async () => {
  server.use(
    http.get('*/system/intelligence/territorial-alerts', () =>
      HttpResponse.json([
        { ...alertFixture('alta-1', 'Pendiente de verificación'), first_validator: 'ana' },
      ]),
    ),
    http.get('*/system/intelligence/territorial-summary', () =>
      HttpResponse.json({
        version: '2.6',
        project_id: 'PRJ-DEMO',
        total: 1,
        by_status: { 'Pendiente de verificación': 1 },
        by_priority: { Alta: 1 },
        themes: [],
        irsa_integration: 'Sin modificación automática',
        caution: 'Revisión humana',
      }),
    ),
    http.patch('*/system/intelligence/territorial-alerts/alta-1', () =>
      HttpResponse.json({
        ok: true,
        status: 'Pendiente de verificación',
        second_validation_required: true,
        irsa_modified: false,
        notice: 'La validación NO cambia el IRSA.',
      }),
    ),
  );
  mount(<IntelligencePage {...context} role="analista" />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ver alerta alta-1' }));
  expect(screen.getByText(/Primera validación: ana\./)).toBeVisible();
  await user.selectOptions(screen.getByLabelText('Estado de revisión'), 'Corroborado');
  await user.click(screen.getByRole('button', { name: 'Guardar revisión' }));
  expect(
    await screen.findByText('Primera validación registrada; otra persona debe confirmarla.'),
  ).toBeVisible();
});
