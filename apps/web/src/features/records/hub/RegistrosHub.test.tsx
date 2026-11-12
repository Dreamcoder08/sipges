import type { Role } from '@sipges/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installRecordsApi } from '../../../test/records-api.ts';
import { api, resetApi } from '../../../test/server.ts';
import { RegistrosHub } from './RegistrosHub.tsx';

const SCOPE = 'ACME/P1';
const rows = {
  [`${SCOPE}/eventos`]: [
    {
      _id: 'E-1',
      Fecha: '2026-10-28',
      Territorio: 'Bayóvar',
      Descripcion_Hecho: 'Bloqueo del muelle',
      Nivel_Verificacion: 'B - Corroborada',
      Estado_Validacion: 'Validado',
    },
    {
      _id: 'E-2',
      Fecha: '2026-10-30',
      Territorio: 'Bernal',
      Descripcion_Hecho: 'Mancha en la playa',
      Nivel_Verificacion: 'E - No verificada',
      Estado_Validacion: 'Preliminar',
    },
  ],
  [`${SCOPE}/actores`]: [{ _id: 'A-1', 'Nombre_Actor/Organizacion': 'Federación de Pescadores' }],
  [`${SCOPE}/demandas`]: [{ _id: 'D-1', Descripcion: 'Revisar la zona de exclusión' }],
};

const renderHub = (tipo: string | undefined, onTipo = vi.fn(), role: Role = 'admin') =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RegistrosHub
        tipo={tipo}
        onTipo={onTipo}
        scope={SCOPE}
        projectId="P1"
        projectLabel="Proyecto Uno"
        role={role}
      />
    </QueryClientProvider>,
  );

beforeEach(() => {
  resetApi();
  installRecordsApi(rows);
  sessionStorage.clear();
});
afterEach(() => sessionStorage.clear());

it('shows a chip per record type with its count, and Todos as the sum', async () => {
  renderHub(undefined);
  const types = screen.getByRole('group', { name: 'Tipo de registro' });
  expect(await within(types).findByRole('button', { name: 'Todos 4' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  for (const name of [
    'Eventos 2',
    'Actores 1',
    'Directorio territorial 0',
    'Demandas 1',
    'Narrativas 0',
    'Fuentes 0',
    'Buzón 0',
  ])
    expect(await within(types).findByRole('button', { name })).toBeInTheDocument();
});

it('reads Todos and every count from one summary request, not one list per type', async () => {
  renderHub('todos');
  await screen.findByText('Bloqueo del muelle');
  expect(await screen.findByRole('button', { name: 'Eventos 2' })).toBeInTheDocument();
  expect(api.requests.filter((request) => request.startsWith('GET /api/'))).toEqual([
    'GET /api/registros/summary',
  ]);
});

it('lists every type together under Todos, with verification and validation as chips', async () => {
  renderHub('todos');
  const table = await screen.findByRole('table');
  expect(await within(table).findByText('Bloqueo del muelle')).toBeInTheDocument();
  expect(within(table).getByText('Federación de Pescadores')).toBeInTheDocument();
  const bayovar = within(table).getByRole('row', { name: /E-1/ });
  expect(within(bayovar).getByText('B', { selector: '[data-verification]' })).toBeInTheDocument();
  expect(within(bayovar).getByText('Validado')).toBeInTheDocument();
});

/** Opens the one filter sheet from the «Filtros» button and returns it. */
const openFilters = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('button', { name: /^Filtros/ }));
  return screen.findByRole('dialog', { name: 'Filtros' });
};

it('filters Todos by verification letter and by validation state from one sheet', async () => {
  const user = userEvent.setup();
  renderHub('todos');
  await screen.findByText('Bloqueo del muelle');
  // The facets are not stacked on the page: they live in the sheet.
  expect(screen.queryByRole('group', { name: 'Verificación A a E' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Filtros' })).toHaveAttribute(
    'aria-haspopup',
    'dialog',
  );
  const sheet = await openFilters(user);
  await user.click(
    within(within(sheet).getByRole('group', { name: 'Verificación A a E' })).getByRole('button', {
      name: 'E',
    }),
  );
  expect(screen.queryByText('Bloqueo del muelle')).not.toBeInTheDocument();
  expect(screen.getByText('Mancha en la playa')).toBeInTheDocument();
  await user.click(within(sheet).getByRole('button', { name: 'Ver 1 registro' }));
  expect(screen.queryByRole('dialog', { name: 'Filtros' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Filtros 1' })).toHaveFocus();

  const again = await openFilters(user);
  await user.click(
    within(within(again).getByRole('group', { name: 'Validación' })).getByRole('button', {
      name: 'Validado',
    }),
  );
  expect(within(again).getByRole('button', { name: 'Ver 0 registros' })).toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(screen.getByRole('button', { name: 'Filtros 2' })).toBeInTheDocument();
  expect(screen.getByText(/Ningún registro coincide/)).toBeInTheDocument();
});

it('shows each active filter as a chip that removes it, and «Limpiar filtros» removes them all', async () => {
  const user = userEvent.setup();
  renderHub('todos');
  await screen.findByText('Bloqueo del muelle');
  expect(screen.queryByRole('group', { name: 'Filtros activos' })).not.toBeInTheDocument();
  const sheet = await openFilters(user);
  await user.click(within(sheet).getByRole('button', { name: 'E' }));
  await user.click(within(sheet).getByRole('button', { name: 'Preliminar' }));
  await user.keyboard('{Escape}');
  const chips = screen.getByRole('group', { name: 'Filtros activos' });
  expect(
    within(chips)
      .getAllByRole('button')
      .map((chip) => chip.textContent),
  ).toEqual(['Verificación E', 'Validación: Preliminar', 'Limpiar filtros']);
  await user.click(within(chips).getByRole('button', { name: 'Quitar filtro Verificación E' }));
  expect(screen.getByRole('button', { name: 'Filtros 1' })).toBeInTheDocument();
  expect(screen.queryByText('Bloqueo del muelle')).not.toBeInTheDocument();
  expect(screen.getByText('Mancha en la playa')).toBeInTheDocument();
  // Focus stays on the chip row instead of falling to the page.
  expect(
    within(chips).getByRole('button', { name: 'Quitar filtro Validación: Preliminar' }),
  ).toHaveFocus();
  await user.click(within(chips).getByRole('button', { name: 'Limpiar filtros' }));
  expect(screen.queryByRole('group', { name: 'Filtros activos' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Filtros' })).toHaveFocus();
  expect(screen.getByText('Bloqueo del muelle')).toBeInTheDocument();
});

it('offers to show every record when nothing matches the search and filters', async () => {
  const user = userEvent.setup();
  renderHub('todos');
  await user.type(await screen.findByRole('searchbox', { name: 'Buscar en registros' }), 'zzz');
  expect(screen.getByText('Ningún registro coincide con estos filtros.')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Mostrar todos los registros' }));
  expect(screen.getByRole('searchbox', { name: 'Buscar en registros' })).toHaveValue('');
  expect(screen.getByText('Bloqueo del muelle')).toBeInTheDocument();
});

it('asks for the chosen type through ?tipo= and renders the type screen with its actions', async () => {
  const user = userEvent.setup();
  const onTipo = vi.fn();
  renderHub('todos', onTipo);
  await user.click(await screen.findByRole('button', { name: 'Eventos 2' }));
  expect(onTipo).toHaveBeenCalledWith('eventos');
});

it('renders the existing records screen for a type, unknown values fall back to Todos', async () => {
  const typed = renderHub('eventos');
  expect(await screen.findByRole('button', { name: 'Nuevo registro' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Importar CSV' })).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: 'Eventos 2' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  typed.unmount();
  renderHub('inexistente');
  expect(await screen.findByRole('button', { name: /^Todos/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

it('opens a record in a side sheet with links and history, and Esc returns focus', async () => {
  const user = userEvent.setup();
  renderHub('todos');
  const open = await screen.findByRole('button', { name: /Abrir E-1/ });
  await user.click(open);
  const sheet = await screen.findByRole('dialog', { name: /E-1/ });
  expect(within(sheet).getByText('Bloqueo del muelle', { selector: 'dd' })).toBeInTheDocument();
  expect(await within(sheet).findByText('Historial de cambios')).toBeInTheDocument();
  expect(within(sheet).getByRole('link', { name: 'Abrir ficha completa' })).toHaveAttribute(
    'href',
    '/objeto/eventos/E-1',
  );
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(open).toHaveFocus();
});

it('opens «Ver» of a type screen in the sheet instead of replacing the list', async () => {
  const user = userEvent.setup();
  renderHub('eventos');
  await user.click(await screen.findByRole('button', { name: 'Ver E-1' }));
  const sheet = await screen.findByRole('dialog', { name: /E-1/ });
  expect(within(sheet).getByRole('link', { name: 'Abrir ficha completa' })).toBeInTheDocument();
  expect(screen.getByRole('table')).toBeInTheDocument();
});

it('keeps density per tab in sessionStorage and nothing in localStorage', async () => {
  const user = userEvent.setup();
  localStorage.clear();
  const first = renderHub('todos');
  const density = await screen.findByRole('group', { name: 'Densidad de filas' });
  expect(within(density).getByRole('button', { name: 'Cómoda' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await user.click(within(density).getByRole('button', { name: 'Compacta' }));
  expect(within(density).getByRole('button', { name: 'Compacta' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(sessionStorage.length).toBe(1);
  expect(localStorage.length).toBe(0);
  first.unmount();
  const second = renderHub('eventos');
  const other = await screen.findByRole('group', { name: 'Densidad de filas' });
  expect(within(other).getByRole('button', { name: 'Cómoda' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  second.unmount();
  renderHub('todos');
  const again = await screen.findByRole('group', { name: 'Densidad de filas' });
  expect(within(again).getByRole('button', { name: 'Compacta' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

it('puts search, the «Filtros» button, density and the count in one toolbar, with no card around the table', async () => {
  renderHub('todos');
  const toolbar = await screen.findByRole('group', { name: 'Filtros de registros' });
  expect(within(toolbar).getByRole('searchbox', { name: 'Buscar en registros' })).toBeVisible();
  expect(within(toolbar).getByRole('button', { name: 'Filtros' })).toBeVisible();
  expect(within(toolbar).getByRole('group', { name: 'Densidad de filas' })).toBeVisible();
  expect(await within(toolbar).findByRole('status')).toHaveTextContent('4 de 4 registros');
  expect(screen.queryByRole('heading', { name: 'Todos los registros' })).not.toBeInTheDocument();
});

it('shows the type with its icon, verification as a toned letter and validation as a status chip', async () => {
  renderHub('todos');
  const event = await screen.findByRole('row', { name: /E-2/ });
  const type = within(event).getByText('Eventos', { selector: '[data-type-chip]' });
  expect(type.querySelector('svg')).not.toBeNull();
  expect(within(event).getByText('E', { selector: '[data-verification="E"]' })).toBeInTheDocument();
  // The shared status family: Preliminar is the neutral tone, shape plus word.
  expect(within(event).getByText('Preliminar')).toHaveAttribute('data-tone', 'neutral');
  const actor = screen.getByRole('row', { name: /A-1/ });
  expect(within(actor).getAllByText('—').length).toBeGreaterThanOrEqual(3);
  expect(actor.querySelector('[data-tone]')).toBeNull();
});

it('offers Importar and Nuevo registro on Todos through a type picker, reusing the type screen', async () => {
  const user = userEvent.setup();
  const onTipo = vi.fn();
  const view = renderHub('todos', onTipo);
  const props = {
    onTipo,
    scope: SCOPE,
    projectId: 'P1',
    projectLabel: 'Proyecto Uno',
    role: 'admin' as Role,
  };
  const create = await screen.findByRole('button', { name: 'Nuevo registro' });
  expect(screen.getByRole('button', { name: 'Importar' })).toBeInTheDocument();
  await user.click(create);
  const picker = screen.getByRole('menu', { name: 'Tipo del nuevo registro' });
  await user.click(within(picker).getByRole('menuitem', { name: 'Eventos' }));
  expect(onTipo).toHaveBeenCalledWith('eventos');
  view.rerender(
    <QueryClientProvider client={new QueryClient()}>
      <RegistrosHub tipo="eventos" {...props} />
    </QueryClientProvider>,
  );
  expect(await screen.findByRole('button', { name: 'Guardar registro' })).toBeInTheDocument();
});

it('hides the Todos write actions from read-only roles', async () => {
  renderHub('todos', vi.fn(), 'consulta');
  await screen.findByRole('table');
  expect(screen.queryByRole('button', { name: 'Nuevo registro' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Importar' })).not.toBeInTheDocument();
});

describe('at 1280 px or wider', () => {
  const original = window.matchMedia;
  beforeEach(() => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes('min-width: 80rem'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => {
    window.matchMedia = original;
  });

  it('docks the record sheet beside a list that stays usable; Esc closes and returns focus', async () => {
    const user = userEvent.setup();
    renderHub('todos');
    const first = await screen.findByRole('button', { name: /Abrir E-1/ });
    await user.click(first);
    const sheet = await screen.findByRole('dialog', { name: /E-1/ });
    expect(sheet).toHaveAttribute('aria-modal', 'false');
    expect(document.body.querySelector('[inert]')).toBeNull();
    expect(document.body.style.overflow).not.toBe('hidden');
    // The list is still live: another record replaces the one in the sheet.
    await user.click(screen.getByRole('button', { name: /Abrir E-2/ }));
    expect(await screen.findByRole('dialog', { name: /E-2/ })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Abrir E-2/ })).toHaveFocus();
  });
});

it('keeps write actions off the type screen for read-only roles', async () => {
  renderHub('eventos', vi.fn(), 'consulta');
  expect(await screen.findByRole('button', { name: 'Ver E-1' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Nuevo registro' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Editar E-1' })).not.toBeInTheDocument();
});
