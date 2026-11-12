import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { fetchModuleRecords } from '../../shared/api/module-records.ts';
import { server } from '../../test/server.ts';
import { DecisionInbox } from './DecisionInbox.tsx';
import type { UseQuality } from './model.ts';

const context = {
  scope: 'DEMO/PRJ-DEMO',
  projectId: 'PRJ-DEMO',
  projectLabel: 'Demo',
  role: 'coordinador' as const,
  username: 'demo',
  fullName: 'Persona de prueba',
};
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

type Alert = Record<string, unknown> & { id: string; status: string; level: string };
const alert = (id: string, level: string, extra: Record<string, unknown> = {}): Alert => ({
  id,
  project_id: 'PRJ-DEMO',
  created_at: hoursAgo(72),
  source_url: '',
  source_type: 'Publicación digital',
  territory: 'Zona Uno',
  source_record: null,
  excerpt: `Publicación sintética ${id}`,
  sha256: 'abc',
  level,
  score: 9,
  method: 'Reglas',
  semantic_active: false,
  status: 'Pendiente de verificación',
  analyst_note: '',
  reviewer_note: null,
  reviewed_at: null,
  first_validator: null,
  themes: [],
  signals: [],
  suggestions: ['Verificar con la fuente'],
  ...extra,
});

const situation = (key: string, level: string) => ({
  key,
  kind: 'tema',
  label: `Situación ${key}`,
  level,
  score: 5,
  trend: 'estable',
  summary: 'Resumen sintético',
  reasons: [{ text: `Motivo de ${key}`, records: [] }],
  recommendations: [],
  records: [],
  actors: [],
  territories: ['Zona Dos'],
  topics: [],
  last_date: '2026-10-20',
});

type Setup = {
  alerts?: Alert[];
  rows?: number;
  situations?: ReturnType<typeof situation>[];
  raised?: Record<string, unknown>[];
  actors?: Record<string, unknown>[];
  failAlerts?: boolean;
};
const patches: { id: string; body: { status: string; reviewer_note: string } }[] = [];
const install = (setup: Setup = {}) => {
  const alerts = structuredClone(setup.alerts ?? []);
  patches.length = 0;
  server.use(
    http.get('*/system/intelligence/territorial-alerts', () =>
      setup.failAlerts
        ? HttpResponse.json({ detail: 'Servicio no disponible' }, { status: 503 })
        : HttpResponse.json(alerts),
    ),
    http.patch('*/system/intelligence/territorial-alerts/:id', async ({ params, request }) => {
      const body = (await request.json()) as { status: string; reviewer_note: string };
      patches.push({ id: String(params.id), body });
      const found = alerts.find((a) => a.id === params.id);
      if (!found) return HttpResponse.json({ detail: 'Evaluación no encontrada' }, { status: 404 });
      if (found.level === 'Alta' && !found.first_validator) {
        found.first_validator = 'demo';
        return HttpResponse.json({
          ok: true,
          status: found.status,
          second_validation_required: true,
          irsa_modified: false,
          notice: 'Sin cambio del IRSA',
        });
      }
      if (found.level === 'Alta' && found.first_validator === 'demo')
        return HttpResponse.json(
          { detail: 'Otra persona debe confirmar la validación de una alerta de prioridad Alta' },
          { status: 409 },
        );
      found.status = body.status;
      found.reviewer_note = body.reviewer_note;
      return HttpResponse.json({
        ok: true,
        status: body.status,
        second_validation_required: false,
        irsa_modified: false,
        notice: 'Sin cambio del IRSA',
      });
    }),
    http.get('*/system/validation-template', () =>
      HttpResponse.json({
        status: 'PENDIENTE',
        rows: Array.from({ length: setup.rows ?? 0 }, (_, i) => ({
          dimension: 'E',
          code: `E${i + 1}`,
          name: `Indicador ${i + 1}`,
          definition: 'Definición',
          expert_1: null,
          expert_2: null,
          expert_3: null,
          expert_4: null,
          expert_5: null,
          aiken_v: null,
          decision: 'Pendiente',
        })),
      }),
    ),
    http.get('*/system/v4/situations', () =>
      HttpResponse.json({
        generated_at: '2026-10-21T00:00:00Z',
        today: '2026-10-21',
        window_days: 90,
        considered: 3,
        undated: 0,
        situations: setup.situations ?? [],
        narratives: { total: 0, recent: 0, topics: [], platforms: [], tone: null },
        method: 'Reglas',
        limitations: [],
      }),
    ),
    http.get('*/api/alertas', () => HttpResponse.json(setup.raised ?? [])),
    http.get('*/api/actores', () => HttpResponse.json(setup.actors ?? [])),
  );
  return { alerts };
};

/** Stands in for the records feature's review: actors without a territory are observations. */
const useStubQuality: UseQuality = (scope) => {
  const query = useQuery({
    queryKey: ['stub-quality', scope],
    queryFn: ({ signal }) => fetchModuleRecords('actores', scope, '', signal),
  });
  if (query.isError) return { state: 'error', retry: () => void query.refetch() };
  if (!query.data) return { state: 'loading' };
  return {
    state: 'ready',
    observations: query.data
      .filter((row) => !row.Territorio)
      .map((row) => ({
        module: 'actores',
        id: row._id,
        title: String(row.Nombre ?? row._id),
        field: 'Territorio',
        reason: 'Sin territorio registrado',
      })),
  };
};

const mount = (props: Partial<Parameters<typeof DecisionInbox>[0]> = {}) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <DecisionInbox {...context} useQuality={useStubQuality} {...props} />
    </QueryClientProvider>,
  );

const list = () => screen.findByRole('listbox', { name: 'Pendientes de decisión' });
const selected = (box: HTMLElement) =>
  within(box)
    .getAllByRole('option')
    .filter((option) => option.getAttribute('aria-selected') === 'true')
    .map((option) => option.textContent);
const detail = () => screen.getByRole('region', { name: 'Detalle del pendiente' });

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe('Pendientes: aggregation and grouping', () => {
  it('lists what awaits a decision from every source, grouped by urgency', async () => {
    install({
      alerts: [
        alert('ALT-1', 'Alta'),
        alert('ALT-2', 'Media'),
        alert('ALT-3', 'Alta', { status: 'Corroborado' }),
      ],
      // The expert template still has pending rows; it is not an inbox item.
      rows: 2,
      situations: [
        situation('rojo', 'Rojo'),
        situation('verde', 'Verde'),
        situation('ya-alerta', 'Naranja'),
      ],
      raised: [{ _id: 'AL-9', Origen: 'SIPGES', Situacion: 'ya-alerta' }],
      actors: [
        { _id: 'AC-1', Nombre: 'Actor sin territorio' },
        { _id: 'AC-2', Territorio: 'X' },
      ],
    });
    mount();
    const box = await list();
    await waitFor(() => expect(within(box).getAllByRole('option')).toHaveLength(4));
    const groups = within(box).getAllByRole('group');
    const [urgent, priority, routine] = groups;
    if (!urgent || !priority || !routine) throw new Error('expected three groups');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual([
      'Urgente',
      'Prioritario',
      'Rutina',
    ]);
    // urgent: the Alta alert and the Rojo situation; Corroborado, Verde and raised ones are out
    expect(within(urgent).getAllByRole('option')).toHaveLength(2);
    expect(within(urgent).getByText(/Publicación sintética ALT-1/)).toBeVisible();
    expect(within(urgent).getByText('Situación rojo')).toBeVisible();
    expect(within(priority).getByText(/Publicación sintética ALT-2/)).toBeVisible();
    expect(within(routine).getAllByRole('option')).toHaveLength(1);
    expect(within(routine).getByText('Actor sin territorio: 1 observación')).toBeVisible();
    expect(screen.queryByText(/Validación de indicadores/)).toBeNull();
    expect(screen.queryByText(/ALT-3/)).toBeNull();
    expect(screen.queryByText('Situación verde')).toBeNull();
    expect(screen.queryByText('Situación ya-alerta')).toBeNull();
    // type, age and territory of an alert
    const first = within(urgent).getByRole('option', { name: /ALT-1/ });
    expect(first).toHaveTextContent('Alerta');
    expect(first).toHaveTextContent('hace 3 d');
    expect(first).toHaveTextContent('Zona Uno');
  });

  it('filters by type and shows the count of each', async () => {
    install({
      alerts: [alert('ALT-1', 'Alta'), alert('ALT-2', 'Media')],
      actors: [{ _id: 'AC-1', Nombre: 'Actor sin territorio' }],
      situations: [situation('rojo', 'Rojo')],
    });
    mount();
    const box = await list();
    const user = userEvent.setup();
    await waitFor(() => expect(within(box).getAllByRole('option')).toHaveLength(4));
    const filter = screen.getByRole('combobox', { name: 'Filtrar pendientes' });
    expect(
      within(filter)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Todo (4)', 'Alertas (2)', 'Calidad de datos (1)', 'Situaciones (1)']);
    expect(
      screen.queryByRole('button', { name: /^(Todo|Alertas|Calidad de datos|Situaciones)/ }),
    ).toBeNull();
    await user.selectOptions(filter, 'alerta');
    expect(within(box).getAllByRole('option')).toHaveLength(2);
    expect(within(box).getByRole('option', { name: /ALT-1/ })).toBeVisible();
    await user.selectOptions(filter, 'calidad');
    expect(within(box).getAllByRole('option')).toHaveLength(1);
    expect(within(box).getByText(/AC-1/)).toBeVisible();
    await user.selectOptions(filter, 'situacion');
    expect(within(box).getAllByRole('option')).toHaveLength(1);
    expect(within(box).getByText('Situación rojo')).toBeVisible();
    await user.selectOptions(filter, 'todo');
    expect(within(box).getAllByRole('option')).toHaveLength(4);
  });

  it('never lists the expert-validation template, so the inbox can be clear', async () => {
    // Validación keeps its own Bandeja tab: its template never resolves, so it cannot be a pending item.
    install({ rows: 3 });
    mount();
    expect(await screen.findByText('Nada pendiente. Bandeja al día.')).toBeVisible();
    expect(screen.queryByText(/Validación de indicadores/)).toBeNull();
    expect(within(await list()).queryByRole('option')).toBeNull();
  });

  it('shows the empty state only when every source answered and nothing is pending', async () => {
    install();
    mount();
    expect(await screen.findByText('Nada pendiente. Bandeja al día.')).toBeVisible();
  });

  it('does not claim the inbox is clear when a source failed', async () => {
    install({ failAlerts: true });
    mount();
    expect(await screen.findByText(/No se pudo cargar las alertas/)).toBeVisible();
    expect(screen.queryByText('Nada pendiente. Bandeja al día.')).toBeNull();
  });
});

describe('Pendientes: keyboard', () => {
  it('moves with J and K, opens the detail with Enter and closes it with Escape', async () => {
    install({ alerts: [alert('ALT-1', 'Alta'), alert('ALT-2', 'Media')] });
    mount();
    const box = await list();
    const user = userEvent.setup();
    await waitFor(() => expect(within(box).getAllByRole('option')).toHaveLength(2));
    expect(selected(box)[0]).toMatch(/ALT-1/);
    await user.keyboard('j');
    expect(selected(box)[0]).toMatch(/ALT-2/);
    expect(within(detail()).getByRole('heading', { level: 2 })).toHaveTextContent(/ALT-2/);
    await user.keyboard('j');
    expect(selected(box)[0]).toMatch(/ALT-2/); // stops at the end
    await user.keyboard('k');
    expect(selected(box)[0]).toMatch(/ALT-1/);

    await user.keyboard('{Enter}');
    expect(within(detail()).getByRole('heading', { level: 2 })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(box).toHaveFocus();
  });

  it('ignores the shortcuts while typing in a field', async () => {
    install({ alerts: [alert('ALT-1', 'Alta'), alert('ALT-2', 'Media')] });
    mount({
      useQuality: ((scope) => {
        void scope;
        return { state: 'ready', observations: [] };
      }) satisfies UseQuality,
    });
    const box = await list();
    const user = userEvent.setup();
    await waitFor(() => expect(within(box).getAllByRole('option')).toHaveLength(2));
    await user.keyboard('r');
    const reason = await screen.findByLabelText(/Motivo del rechazo/);
    await user.type(reason, 'jk');
    expect(selected(box)[0]).toMatch(/ALT-1/);
    expect(reason).toHaveValue('jk');
  });
});

describe('Pendientes: four eyes', () => {
  it('never offers Aprobar to the person who made the first validation', async () => {
    const { alerts } = install({
      alerts: [alert('ALT-1', 'Alta', { first_validator: 'demo' })],
    });
    mount();
    await list();
    const user = userEvent.setup();
    await within(detail()).findByRole('heading', { level: 2 });
    expect(within(detail()).queryByRole('button', { name: /Aprobar/ })).toBeNull();
    expect(within(detail()).getByText(/No puedes aprobarla/)).toBeVisible();
    expect(within(detail()).getByText('demo')).toBeVisible();
    await user.keyboard('a');
    expect(patches).toHaveLength(0);
    expect(alerts[0]?.status).toBe('Pendiente de verificación');
    // the hint only names the shortcuts that exist
    expect(screen.queryByText('A', { selector: 'kbd' })).toBeNull();
  });

  it('lets someone else confirm a first validation', async () => {
    install({ alerts: [alert('ALT-1', 'Alta', { first_validator: 'otra.persona' })] });
    mount();
    await list();
    const approve = await within(detail()).findByRole('button', { name: /Aprobar/ });
    expect(approve).toBeEnabled();
    expect(within(detail()).getByText(/otra\.persona hizo la primera validación/)).toBeVisible();
  });

  it('keeps a first validation in the list and says a second person must confirm', async () => {
    install({ alerts: [alert('ALT-1', 'Alta')] });
    mount();
    const box = await list();
    const user = userEvent.setup();
    await user.click(await within(detail()).findByRole('button', { name: /Aprobar/ }));
    expect(await screen.findByText(/Primera validación de ALT-1 registrada/)).toBeVisible();
    expect(patches).toHaveLength(1);
    await waitFor(() =>
      expect(within(detail()).queryByRole('button', { name: /Aprobar/ })).toBeNull(),
    );
    expect(within(box).getAllByRole('option')).toHaveLength(1);
  });

  it('offers no decision to a read-only role', async () => {
    install({ alerts: [alert('ALT-1', 'Media')] });
    mount({ role: 'consulta' });
    await list();
    await within(detail()).findByRole('heading', { level: 2 });
    expect(within(detail()).queryByRole('button', { name: /Aprobar|Rechazar/ })).toBeNull();
    expect(within(detail()).getByText(/solo lectura/)).toBeVisible();
  });
});

describe('Pendientes: actions use the existing mutation', () => {
  it('approves with A: PATCH status Corroborado and the item leaves the list', async () => {
    install({ alerts: [alert('ALT-1', 'Media'), alert('ALT-2', 'Media')] });
    mount();
    const box = await list();
    const user = userEvent.setup();
    await waitFor(() => expect(within(box).getAllByRole('option')).toHaveLength(2));
    await user.keyboard('a');
    await waitFor(() => expect(within(box).getAllByRole('option')).toHaveLength(1));
    expect(patches).toEqual([{ id: 'ALT-1', body: { status: 'Corroborado', reviewer_note: '' } }]);
    expect(within(box).queryByText(/ALT-1/)).toBeNull();
    expect(selected(box)[0]).toMatch(/ALT-2/);
  });

  it('rejects with R only after a reason is written', async () => {
    install({ alerts: [alert('ALT-1', 'Media')] });
    mount();
    const box = await list();
    const user = userEvent.setup();
    await within(detail()).findByRole('heading', { level: 2 });
    await user.keyboard('r');
    await user.click(await screen.findByRole('button', { name: 'Confirmar rechazo' }));
    expect(await screen.findByText('Escribe el motivo para rechazar.')).toBeVisible();
    expect(patches).toHaveLength(0);
    await user.type(screen.getByLabelText(/Motivo del rechazo/), 'Duplicada');
    await user.click(screen.getByRole('button', { name: 'Confirmar rechazo' }));
    await waitFor(() => expect(within(box).queryAllByRole('option')).toHaveLength(0));
    expect(patches).toEqual([
      { id: 'ALT-1', body: { status: 'Descartado', reviewer_note: 'Duplicada' } },
    ]);
  });

  it('shows the server refusal as it is (the rule stays authoritative)', async () => {
    const { alerts } = install({
      alerts: [alert('ALT-1', 'Alta', { first_validator: 'otra.persona' })],
    });
    mount();
    await list();
    const user = userEvent.setup();
    // the person who validated first changes in the meantime: the UI offered Aprobar, the server says no
    const approve = await within(detail()).findByRole('button', { name: /Aprobar/ });
    const stored = alerts.find((entry) => entry.id === 'ALT-1');
    if (stored) stored.first_validator = 'demo';
    await user.click(approve);
    expect(await screen.findByText(/Otra persona debe confirmar la validación/)).toBeVisible();
  });

  it('links to the owning screen where there is no inline action', async () => {
    install({
      situations: [situation('rojo', 'Rojo')],
      actors: [{ _id: 'AC-1', Nombre: 'Actor sin territorio' }],
    });
    mount();
    const box = await list();
    const user = userEvent.setup();
    await waitFor(() => expect(within(box).getAllByRole('option')).toHaveLength(2));
    expect(within(detail()).getByRole('link', { name: /Situaciones/ })).toHaveAttribute(
      'href',
      '/bandeja?vista=situaciones',
    );
    expect(within(detail()).queryByRole('button', { name: /Aprobar|Rechazar/ })).toBeNull();
    await user.keyboard('j');
    expect(within(detail()).getByRole('link', { name: /Revisar AC-1/ })).toHaveAttribute(
      'href',
      '/objeto/actores/AC-1',
    );
  });
});

describe('Pendientes: persistence', () => {
  it('writes nothing to localStorage', async () => {
    install({ alerts: [alert('ALT-1', 'Media')] });
    mount();
    await list();
    const user = userEvent.setup();
    await within(detail()).findByRole('heading', { level: 2 });
    await user.keyboard('j{Enter}{Escape}');
    expect(window.localStorage.length).toBe(0);
  });
});

describe('Pendientes: selection and filter in the URL', () => {
  it('closes on URL removal and reopens the same item when the URL restores it', async () => {
    install({ alerts: [alert('ALT-1', 'Media')] });
    const Harness = () => {
      const [url, setUrl] = useState<string | undefined>('alerta:ALT-1');
      return (
        <>
          <button onClick={() => setUrl(undefined)}>Remove linked item</button>
          <button onClick={() => setUrl('alerta:ALT-1')}>Restore linked item</button>
          <DecisionInbox
            {...context}
            useQuality={useStubQuality}
            pendiente={url}
            onUrl={(next) => setUrl(next.pendiente)}
          />
        </>
      );
    };
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Harness />
      </QueryClientProvider>,
    );
    await list();
    const user = userEvent.setup();
    expect(detail().parentElement).toHaveAttribute('data-open', 'true');
    await user.click(screen.getByRole('button', { name: 'Remove linked item' }));
    expect(detail().parentElement).toHaveAttribute('data-open', 'false');
    await user.click(screen.getByRole('button', { name: 'Restore linked item' }));
    expect(detail().parentElement).toHaveAttribute('data-open', 'true');
    await user.keyboard('{Escape}');
    expect(detail().parentElement).toHaveAttribute('data-open', 'false');
    await user.click(screen.getByRole('button', { name: 'Restore linked item' }));
    expect(detail().parentElement).toHaveAttribute('data-open', 'true');
  });

  it('writes the initially highlighted item to the URL when Enter opens it', async () => {
    install({ alerts: [alert('ALT-1', 'Media')] });
    const writes: { pendiente?: string | undefined; clase?: string | undefined }[] = [];
    mount({ onUrl: (next) => writes.push(next) });
    const box = await list();
    await waitFor(() => expect(within(box).getAllByRole('option')).toHaveLength(1));
    box.focus();
    await userEvent.setup().keyboard('{Enter}');
    expect(writes).toEqual([{ pendiente: 'alerta:ALT-1' }]);
  });
  it('opens the item the URL names, so a reload or a shared link keeps it', async () => {
    install({ alerts: [alert('ALT-1', 'Alta'), alert('ALT-2', 'Media')] });
    mount({ pendiente: 'alerta:ALT-2', onUrl: () => undefined });
    const box = await list();
    await waitFor(() => expect(selected(box)[0]).toMatch(/ALT-2/));
    expect(within(detail()).getByRole('heading', { level: 2 })).toHaveTextContent(/ALT-2/);
  });

  it('writes the chosen item to the URL on click and on J/K, and clears it with Escape', async () => {
    install({ alerts: [alert('ALT-1', 'Alta'), alert('ALT-2', 'Media')] });
    const writes: { pendiente?: string | undefined; clase?: string | undefined }[] = [];
    mount({ onUrl: (next) => writes.push(next) });
    const box = await list();
    const user = userEvent.setup();
    await waitFor(() => expect(within(box).getAllByRole('option')).toHaveLength(2));
    expect(writes).toEqual([]);
    await user.click(within(box).getByRole('option', { name: /ALT-2/ }));
    expect(writes.at(-1)).toEqual({ pendiente: 'alerta:ALT-2' });
    await user.keyboard('k');
    expect(writes.at(-1)).toEqual({ pendiente: 'alerta:ALT-1' });
    await user.keyboard('{Enter}');
    expect(within(detail()).getByRole('heading', { level: 2 })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(writes.at(-1)).toEqual({ pendiente: undefined });
    expect(box).toHaveFocus();
    expect(window.localStorage.length).toBe(0);
  });

  it('reads the type filter from the URL and writes a new choice back', async () => {
    install({
      alerts: [alert('ALT-1', 'Alta')],
      situations: [situation('rojo', 'Rojo')],
    });
    const writes: { pendiente?: string | undefined; clase?: string | undefined }[] = [];
    mount({ clase: 'situacion', onUrl: (next) => writes.push(next) });
    const box = await list();
    await waitFor(() => expect(within(box).getAllByRole('option')).toHaveLength(1));
    expect(within(box).getByText('Situación rojo')).toBeVisible();
    const filter = screen.getByRole('combobox', { name: 'Filtrar pendientes' });
    expect(filter).toHaveValue('situacion');
    await userEvent.setup().selectOptions(filter, 'alerta');
    expect(writes.at(-1)).toEqual({ clase: 'alerta', pendiente: undefined });
  });

  it('treats an unknown type in the URL as «Todo»', async () => {
    install({ alerts: [alert('ALT-1', 'Alta')], situations: [situation('rojo', 'Rojo')] });
    mount({ clase: 'nada', onUrl: () => undefined });
    const box = await list();
    await waitFor(() => expect(within(box).getAllByRole('option')).toHaveLength(2));
    expect(screen.getByRole('combobox', { name: 'Filtrar pendientes' })).toHaveValue('todo');
  });
});

describe('Pendientes: row status', () => {
  it('shows the four-eyes state of an alert as one status badge per row', async () => {
    install({
      alerts: [
        alert('ALT-1', 'Alta'),
        alert('ALT-2', 'Alta', { first_validator: 'otra.persona' }),
        alert('ALT-3', 'Alta', { first_validator: 'demo' }),
        alert('ALT-4', 'Media'),
      ],
    });
    mount();
    const box = await list();
    await waitFor(() => expect(within(box).getAllByRole('option')).toHaveLength(4));
    const badge = (id: string) =>
      within(box)
        .getByRole('option', { name: new RegExp(id) })
        .querySelector('[data-tone]');
    expect(badge('ALT-1')).toHaveTextContent('Cuatro ojos');
    expect(badge('ALT-1')).toHaveAttribute('data-tone', 'info');
    expect(badge('ALT-2')).toHaveTextContent('Falta confirmar');
    expect(badge('ALT-2')).toHaveAttribute('data-tone', 'warning');
    expect(badge('ALT-3')).toHaveTextContent('Primera validación tuya');
    expect(badge('ALT-3')).toHaveAttribute('data-tone', 'neutral');
    expect(badge('ALT-4')).toBeNull();
  });
});
