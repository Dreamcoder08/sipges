import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { installRecordsApi } from '../test/records-api.ts';
import { resetApi, server } from '../test/server.ts';
import { App } from './App.tsx';
import { DESTINATIONS } from './navigation.ts';

beforeEach(() =>
  resetApi({ me: { username: 'demo', full_name: 'Persona de prueba', role: 'admin' } }),
);
const at = (path: string) => window.history.replaceState(null, '', path);
const pressed = (group: HTMLElement) =>
  within(group)
    .getAllByRole('button')
    .filter((button) => button.getAttribute('aria-pressed') === 'true')
    .map((button) => button.textContent);

describe('destination hubs', () => {
  it.each(DESTINATIONS.filter((hub) => hub.path !== '/registros'))(
    '$label lists its tabs and shows the first one by default',
    async (hub) => {
      installRecordsApi();
      at(hub.path);
      render(<App />);
      expect(await screen.findByRole('heading', { level: 1, name: hub.label })).toBeVisible();
      const tabs = await screen.findByRole('group', { name: hub.label });
      expect(within(tabs).getAllByRole('button')).toHaveLength(hub.tabs.length);
      expect(pressed(tabs)).toEqual([hub.tabs[0]?.label]);
    },
  );

  it('keeps the old routes working as deep links', async () => {
    installRecordsApi({
      'DEMO/PRJ-DEMO/eventos': [{ _id: 'E-1', Descripcion_Hecho: 'Hecho sintético' }],
    });
    at('/eventos');
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Eventos' })).toBeVisible();
    await waitFor(() => expect(screen.getByText('Hecho sintético')).toBeVisible());
  });
});

describe('Riesgo de conflicto', () => {
  // Synthetic localities only.
  const backtest = (horizon: 30 | 90) => ({
    horizon,
    calibrated: false,
    reason: 'Historial insuficiente para calibrar.',
    cutoffs: 0,
    from: null,
    to: null,
    train: { samples: 0, events: 0 },
    test: { samples: 0, events: 0 },
    brier: null,
    brierReference: null,
    skill: null,
    bins: [],
  });
  const unit = (name: string) => ({
    key: `L:${name.toLowerCase()}`,
    kind: 'locality',
    name,
    score: 1,
    signals: 1,
    horizons: {
      '30': { probability: null, band: 'media' },
      '90': { probability: null, band: 'media' },
    },
    confidence: 'baja',
    confidenceReason: 'Historial insuficiente para calibrar.',
    factors: [],
  });

  it(
    'follows a new ?localidad= from the map while the tab stays open',
    { timeout: 20_000 },
    async () => {
      server.use(
        http.get('*/system/conflict-risk', () =>
          HttpResponse.json({
            generatedOn: '2026-11-02',
            status: 'ok',
            method: 'Puntaje transparente.',
            backtest: { '30': backtest(30), '90': backtest(90) },
            localities: [unit('Pampa Alta'), unit('Loma Verde')],
            actors: [],
            limitations: [],
          }),
        ),
      );
      at('/analisis?vista=riesgo&localidad=Loma%20Verde');
      render(<App />);
      expect(await screen.findByRole('heading', { level: 4, name: 'Loma Verde' })).toBeVisible();
      expect(screen.queryByRole('heading', { level: 4, name: 'Pampa Alta' })).toBeNull();
      act(() => {
        window.history.pushState(null, '', '/analisis?vista=riesgo&localidad=Pampa%20Alta');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      expect(await screen.findByRole('heading', { level: 4, name: 'Pampa Alta' })).toBeVisible();
      expect(screen.queryByRole('heading', { level: 4, name: 'Loma Verde' })).toBeNull();
    },
  );
});

describe('Integraciones', () => {
  const installIntegrationsApi = () =>
    server.use(
      http.get('*/system/automations', () =>
        HttpResponse.json({
          sources: [],
          actions: ['CREATE'],
          operators: ['eq'],
          rules: [],
          channels: [],
          runs: [],
        }),
      ),
      http.get('*/system/automations/runtime', () =>
        HttpResponse.json({
          event_processing: true,
          cron_configured: false,
          cron_schedule: null,
          interval_ms: 30000,
          latest_attempt: null,
        }),
      ),
      http.get('*/system/integrations/api-keys', () => HttpResponse.json([])),
      http.get('*/system/intelligence/sources', () => HttpResponse.json({}, { status: 503 })),
      http.get('*/system/geography/catalogue', () => HttpResponse.json({}, { status: 503 })),
    );

  it('is one page at /integraciones with its filters, and /automatizaciones still renders', async () => {
    installIntegrationsApi();
    at('/integraciones');
    const page = render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Integraciones' })).toBeVisible();
    const chips = await screen.findByRole('group', { name: 'Filtrar por tipo' });
    expect(
      within(chips)
        .getAllByRole('button')
        .map((chip) => chip.textContent),
    ).toEqual([
      expect.stringMatching(/^Todos/),
      expect.stringMatching(/^Conectores/),
      expect.stringMatching(/^Skills/),
      expect.stringMatching(/^Programadas/),
    ]);
    page.unmount();

    at('/automatizaciones');
    render(<App />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Automatizaciones e integraciones' }),
    ).toBeVisible();
    expect(await screen.findByLabelText('Nombre de la regla')).toBeVisible();
  });
});

describe('Registros hub', () => {
  const chips = () => screen.findByRole('group', { name: 'Tipo de registro' });
  const label = (button: string | null) => button?.replace(/\s+\S+$/, '');

  it('lists Todos and every record type as chips, Todos by default', async () => {
    installRecordsApi();
    at('/registros');
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Registros' })).toBeVisible();
    const tabs = await chips();
    expect(
      within(tabs)
        .getAllByRole('button')
        .map((b) => label(b.textContent)),
    ).toEqual([
      'Todos',
      ...(DESTINATIONS.find((hub) => hub.path === '/registros')?.tabs ?? []).map(
        (tab) => tab.label,
      ),
    ]);
    expect(pressed(tabs).map(label)).toEqual(['Todos']);
  });

  it('renders the record type named in the URL and keeps the project scope', async () => {
    installRecordsApi({
      'DEMO/PRJ-DEMO/actores': [{ _id: 'A-1', 'Nombre_Actor/Organizacion': 'Actor sintético' }],
    });
    at('/registros?tipo=actores');
    render(<App />);
    expect(within(await screen.findByRole('table')).getByText('Actor sintético')).toBeVisible();
    expect(pressed(await chips()).map(label)).toEqual(['Actores']);
  });

  it('falls back to Todos when the URL names an unknown type', async () => {
    installRecordsApi();
    at('/registros?tipo=inexistente');
    render(<App />);
    expect(pressed(await chips()).map(label)).toEqual(['Todos']);
  });

  it('puts the chosen type in the URL, and back/forward restore it', async () => {
    installRecordsApi({
      'DEMO/PRJ-DEMO/eventos': [{ _id: 'E-1', Descripcion_Hecho: 'Hecho sintético' }],
      'DEMO/PRJ-DEMO/demandas': [{ _id: 'D-1', Descripcion: 'Demanda sintética' }],
    });
    at('/registros');
    render(<App />);
    const user = userEvent.setup();
    const tabs = await chips();
    await waitFor(() => expect(screen.getByText('Hecho sintético')).toBeVisible());

    await user.click(within(tabs).getByRole('button', { name: /^Demandas/ }));
    await waitFor(() => expect(screen.getByText('Demanda sintética')).toBeVisible());
    expect(window.location.pathname + window.location.search).toBe('/registros?tipo=demandas');
    expect(pressed(tabs).map(label)).toEqual(['Demandas']);

    window.history.back();
    await waitFor(() => expect(pressed(tabs).map(label)).toEqual(['Todos']));
    window.history.forward();
    await waitFor(() => expect(pressed(tabs).map(label)).toEqual(['Demandas']));
  });
});

describe('Inicio hub', () => {
  const day = (offset: number) =>
    new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
  const searched: string[] = [];
  const counters = {
    eventos: 2,
    actores: 7,
    demandas_abiertas: 3,
    alertas_activas: 4,
    directorio: 4,
    priorizados: 5,
  };
  const open = async () => {
    searched.length = 0;
    server.use(
      http.get('/api/dashboard', () => HttpResponse.json({ ...counters, niveles: {} })),
      http.get('/api/eventos', () =>
        HttpResponse.json([
          { _id: 'E-1', Descripcion_Hecho: 'Hecho de hoy', Fecha: day(0), Proyecto_ID: 'PRJ-DEMO' },
          {
            _id: 'E-2',
            Descripcion_Hecho: 'Hecho de ayer',
            Fecha: day(1),
            Proyecto_ID: 'PRJ-DEMO',
          },
          { _id: 'E-3', Descripcion_Hecho: 'Hecho viejo', Fecha: day(40), Proyecto_ID: 'PRJ-DEMO' },
          { _id: 'E-4', Descripcion_Hecho: 'Otro proyecto', Fecha: day(0), Proyecto_ID: 'OTRO' },
        ]),
      ),
      http.get('/system/search', ({ request }) => {
        const q = new URL(request.url).searchParams.get('q') ?? '';
        searched.push(q);
        return HttpResponse.json({ query: q, hits: [] });
      }),
    );
    at('/inicio');
    render(<App />);
    return userEvent.setup();
  };

  it('opens on the Inicio tab with Dashboard and Centro gerencial next to it', async () => {
    await open();
    const tabs = await screen.findByRole('group', { name: 'Inicio' });
    expect(
      within(tabs)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Inicio', 'Dashboard', 'Centro gerencial']);
    expect(pressed(tabs)).toEqual(['Inicio']);
  });

  it('greets the user by first name and names the active project, under a single h1', async () => {
    await open();
    expect(
      await screen.findByRole('heading', { level: 2, name: /^Hola, Persona\b/ }),
    ).toBeVisible();
    expect(await screen.findByText(/ · Proyecto Demo$/, { selector: 'p' })).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('searches the typed question in the existing palette without calling a model', async () => {
    const user = await open();
    const composer = await screen.findByRole('textbox', { name: 'Pregunta a SIPGES' });
    await user.type(composer, 'demandas abiertas en Vice');
    await user.click(screen.getByRole('button', { name: 'Enviar pregunta' }));
    const palette = await screen.findByRole('dialog', { name: 'Búsqueda global' });
    expect(within(palette).getByRole('combobox')).toHaveValue('demandas abiertas en Vice');
    await waitFor(() => expect(searched).toContain('demandas abiertas en Vice'));
    expect(localStorage.length).toBe(0);
  });

  it('submits with Enter and ignores an empty question', async () => {
    const user = await open();
    const composer = await screen.findByRole('textbox', { name: 'Pregunta a SIPGES' });
    await user.type(composer, '   {Enter}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.type(composer, 'agua{Enter}');
    expect(await screen.findByRole('dialog', { name: 'Búsqueda global' })).toBeVisible();
  });

  it('fills the composer with a suggested question without submitting it', async () => {
    const user = await open();
    const chips = await screen.findByRole('list', { name: 'Prueba con' });
    const buttons = within(chips).getAllByRole('button');
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    expect(buttons.length).toBeLessThanOrEqual(4);
    const text = buttons[0]?.textContent ?? '';
    await user.click(buttons[0] as HTMLElement);
    expect(screen.getByRole('textbox', { name: 'Pregunta a SIPGES' })).toHaveValue(text);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says that sending opens the search with the question', async () => {
    await open();
    expect(await screen.findByText('Enviar abre la búsqueda con tu pregunta')).toBeVisible();
    expect(screen.queryByText(/citas llegan pronto/)).toBeNull();
  });

  it('briefs from existing data and links to Bandeja, Registros and the IRSA tab of Análisis', async () => {
    await open();
    const decision = await screen.findByRole('region', { name: /Alertas activas/ });
    expect(within(decision).getByText('4')).toBeVisible();
    expect(within(decision).getByRole('link', { name: /Abrir Bandeja/ })).toHaveAttribute(
      'href',
      '/bandeja',
    );
    const fresh = await screen.findByRole('region', { name: /Registros nuevos/ });
    await waitFor(() => expect(within(fresh).getByText('2')).toBeVisible());
    expect(within(fresh).getByText('Hecho de hoy')).toBeVisible();
    expect(within(fresh).queryByText('Hecho viejo')).toBeNull();
    expect(within(fresh).queryByText('Otro proyecto')).toBeNull();
    expect(within(fresh).getByRole('link', { name: /Ver en Registros/ })).toHaveAttribute(
      'href',
      '/registros',
    );
    const territory = await screen.findByRole('region', { name: /Riesgo del territorio/ });
    expect(within(territory).getByText(/^Amarillo/)).toBeVisible();
    expect(within(territory).getByRole('link', { name: /Abrir IRSA/ })).toHaveAttribute(
      'href',
      '/analisis',
    );
    expect(
      within(territory).getByRole('link', { name: /Riesgo de conflicto por localidad/ }),
    ).toHaveAttribute('href', '/analisis?vista=riesgo');
  });

  it('hides the card whose source fails instead of inventing numbers', async () => {
    await open();
    server.use(
      http.get('/api/eventos', () => HttpResponse.json({ detail: 'caído' }, { status: 500 })),
      http.get('/system/irsa', () => HttpResponse.json({ detail: 'caído' }, { status: 500 })),
    );
    await screen.findByRole('region', { name: /Alertas activas/ });
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: /Registros nuevos/ })).toBeNull(),
    );
    expect(screen.queryByRole('region', { name: /Riesgo del territorio/ })).toBeNull();
  });
});

describe('Configuración', () => {
  it('opens the section named in the URL and Apariencia for an unknown one', async () => {
    const user = userEvent.setup();
    at('/version-4?seccion=privacidad');
    const page = render(<App />);
    const nav = await screen.findByRole('navigation', { name: 'Secciones de Configuración' });
    expect(within(nav).getByRole('link', { name: 'Privacidad y datos' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(await screen.findByRole('checkbox', { name: 'Envío a IA externa' })).toBeInTheDocument();
    await user.click(within(nav).getByRole('link', { name: 'Notificaciones' }));
    await waitFor(() => expect(window.location.search).toBe('?seccion=notificaciones'));
    expect(await screen.findByRole('heading', { name: 'Notificaciones' })).toBeVisible();
    page.unmount();

    at('/version-4?seccion=cuenta');
    render(<App />);
    expect(await screen.findByRole('group', { name: 'Tema' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('navigation', { name: 'Secciones de Configuración' })).getByRole(
        'link',
        { name: 'Apariencia' },
      ),
    ).toHaveAttribute('aria-current', 'page');
  });
});
