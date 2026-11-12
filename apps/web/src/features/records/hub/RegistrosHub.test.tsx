import type { Role } from '@sipges/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
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
  // Compromisos live under the Demandas tab (its sub-toggle), not as a chip of their own.
  [`${SCOPE}/compromisos`]: [
    { _id: 'C-1', Descripcion: 'Instalar la mesa técnica', Demanda_Asociada: 'D-1' },
  ],
};

const renderHub = (
  tipo: string | undefined,
  onTipo = vi.fn(),
  role: Role = 'admin',
  url: {
    ficha?: string;
    onFicha?: (ficha: string | undefined) => void;
    verificacion?: string;
    onVerificacion?: (letter: string | undefined) => void;
  } = {},
) =>
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
        {...url}
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

/** Below 1024 px Todos is a list of two-line rows: no table squeezed into the width. */
const recordList = () =>
  screen.findByRole('list', { name: 'Registros de todos los tipos del proyecto activo' });

it('lists every type together under Todos as two-line rows, each one button', async () => {
  renderHub('todos');
  const list = await recordList();
  expect(screen.queryByRole('grid')).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Tabla de registros' })).not.toBeInTheDocument();
  expect(within(list).getAllByRole('listitem')).toHaveLength(4);
  expect(within(list).getByText('Federación de Pescadores')).toBeInTheDocument();
  const row = within(list).getByRole('button', { name: /^Abrir E-1: Bloqueo del muelle/ });
  // The whole row is the one target of its list item.
  const item = row.closest('li') as HTMLElement;
  expect(within(item).getAllByRole('button')).toEqual([row]);
  // Line 1: the title and the shared status badge. Line 2: type · place · date and A–E.
  expect(within(row).getByText('Bloqueo del muelle')).toHaveAttribute('data-line', 'title');
  expect(within(row).getByText('Validado')).toHaveAttribute('data-tone', 'positive');
  expect(row.querySelector('[data-line="meta"]')).toHaveTextContent(
    /^Eventos · Bayóvar · 2026-10-28\s*Verificación B$/,
  );
  expect(within(row).getByText('B', { selector: '[data-verification]' })).toBeInTheDocument();
});

it('leaves out what a row does not have instead of dashes', async () => {
  renderHub('todos');
  const actor = within(await recordList()).getByRole('button', { name: /^Abrir A-1:/ });
  expect(actor.querySelector('[data-line="meta"]')).toHaveTextContent(/^Actores$/);
  expect(actor.querySelector('[data-tone]')).toBeNull();
  expect(within(actor).queryByText('—')).not.toBeInTheDocument();
});

it('opens the record from its row in the modal sheet and names it in the URL', async () => {
  const user = userEvent.setup();
  const onFicha = vi.fn();
  renderHub('todos', vi.fn(), 'admin', { onFicha });
  const row = within(await recordList()).getByRole('button', { name: /^Abrir E-2:/ });
  await user.click(row);
  const sheet = await screen.findByRole('dialog', { name: 'Ficha E-2' });
  expect(sheet).toHaveAttribute('aria-modal', 'true');
  expect(onFicha).toHaveBeenLastCalledWith('eventos.E-2');
  await user.keyboard('{Escape}');
  expect(onFicha).toHaveBeenLastCalledWith(undefined);
  expect(row).toHaveFocus();
});

it('reopens the record the URL names on a phone, so a reload keeps it', async () => {
  renderHub('todos', vi.fn(), 'admin', { ficha: 'eventos.E-1' });
  const sheet = await screen.findByRole('dialog', { name: 'Ficha E-1' });
  expect(sheet).toHaveAttribute('aria-modal', 'true');
  expect(await within(sheet).findByText('Bloqueo del muelle', { selector: 'dd' })).toBeVisible();
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

it('reads the verification letter from the URL and writes a change back to it', async () => {
  const user = userEvent.setup();
  const onVerificacion = vi.fn();
  renderHub('todos', vi.fn(), 'admin', { verificacion: 'E', onVerificacion });
  expect(await screen.findByText('Mancha en la playa')).toBeInTheDocument();
  expect(screen.queryByText('Bloqueo del muelle')).not.toBeInTheDocument();
  const chips = screen.getByRole('group', { name: 'Filtros activos' });
  await user.click(within(chips).getByRole('button', { name: 'Quitar filtro Verificación E' }));
  expect(onVerificacion).toHaveBeenLastCalledWith(undefined);
  const sheet = await openFilters(user);
  await user.click(within(sheet).getByRole('button', { name: 'B' }));
  expect(onVerificacion).toHaveBeenLastCalledWith('B');
});

it('ignores a verification value in the URL that is not A to E', async () => {
  renderHub('todos', vi.fn(), 'admin', { verificacion: 'Z', onVerificacion: vi.fn() });
  expect(await screen.findByText('Mancha en la playa')).toBeInTheDocument();
  expect(screen.getByText('Bloqueo del muelle')).toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Filtros activos' })).not.toBeInTheDocument();
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

it('puts search, «Filtros» and the count in one toolbar; the phone list has no density', async () => {
  renderHub('todos');
  const toolbar = await screen.findByRole('group', { name: 'Filtros de registros' });
  expect(within(toolbar).getByRole('searchbox', { name: 'Buscar en registros' })).toBeVisible();
  expect(within(toolbar).getByRole('button', { name: 'Filtros' })).toBeVisible();
  // Two-line rows have one height: Cómoda and Compacta belong to the desktop table.
  expect(within(toolbar).queryByRole('group', { name: 'Densidad de filas' })).toBeNull();
  expect(await within(toolbar).findByRole('status')).toHaveTextContent('4 de 4 registros');
  expect(screen.queryByRole('heading', { name: 'Todos los registros' })).not.toBeInTheDocument();
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
  await recordList();
  expect(screen.queryByRole('button', { name: 'Nuevo registro' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Importar' })).not.toBeInTheDocument();
});

describe('at 1024 px or wider', () => {
  const original = window.matchMedia;
  beforeEach(() => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes('min-width: 64rem'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => {
    window.matchMedia = original;
  });

  it('lists every type together in a grid, with verification and validation as chips', async () => {
    renderHub('todos');
    const table = await screen.findByRole('grid', {
      name: 'Registros de todos los tipos del proyecto activo',
    });
    expect(screen.queryByRole('list', { name: /Registros de todos/ })).not.toBeInTheDocument();
    expect(await within(table).findByText('Bloqueo del muelle')).toBeInTheDocument();
    expect(within(table).getByText('Federación de Pescadores')).toBeInTheDocument();
    const bayovar = within(table).getByRole('row', { name: /E-1/ });
    expect(within(bayovar).getByText('B', { selector: '[data-verification]' })).toBeInTheDocument();
    expect(within(bayovar).getByText('Validado')).toBeInTheDocument();
  });

  it('keeps the toolbar with density and nothing in localStorage, per tab in sessionStorage', async () => {
    const user = userEvent.setup();
    localStorage.clear();
    const first = renderHub('todos');
    const toolbar = await screen.findByRole('group', { name: 'Filtros de registros' });
    const density = within(toolbar).getByRole('group', { name: 'Densidad de filas' });
    expect(within(density).getByRole('button', { name: 'Compacta' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(within(density).getByRole('button', { name: 'Cómoda' }));
    expect(within(density).getByRole('button', { name: 'Cómoda' })).toHaveAttribute(
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
    expect(within(again).getByRole('button', { name: 'Cómoda' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('shows the type with its icon, verification as a toned letter and validation as a status chip', async () => {
    renderHub('todos');
    const event = await screen.findByRole('row', { name: /E-2/ });
    const type = within(event).getByText('Eventos', { selector: '[data-type-chip]' });
    expect(type.querySelector('svg')).not.toBeNull();
    expect(
      within(event).getByText('E', { selector: '[data-verification="E"]' }),
    ).toBeInTheDocument();
    // The shared status family: Preliminar is the neutral tone, shape plus word.
    expect(within(event).getByText('Preliminar')).toHaveAttribute('data-tone', 'neutral');
    const actor = screen.getByRole('row', { name: /A-1/ });
    expect(within(actor).getAllByText('—').length).toBeGreaterThanOrEqual(3);
    expect(actor.querySelector('[data-tone]')).toBeNull();
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

  it('shows Todos as a dense table: Compacta by default and the A–E letter with its word', async () => {
    renderHub('todos');
    const density = await screen.findByRole('group', { name: 'Densidad de filas' });
    expect(within(density).getByRole('button', { name: 'Compacta' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const row = await screen.findByRole('row', { name: /E-1/ });
    expect(within(row).getByText('Corroborada')).toBeInTheDocument();
    expect(within(row).getByText('Validado')).toHaveAttribute('data-tone', 'positive');
  });

  it('opens the record beside the table from a click anywhere on its row and puts it in the URL', async () => {
    const user = userEvent.setup();
    const onFicha = vi.fn();
    renderHub('todos', vi.fn(), 'admin', { onFicha });
    await user.click(await screen.findByText('Bayóvar'));
    const sheet = await screen.findByRole('dialog', { name: 'Ficha E-1' });
    expect(sheet).toHaveAttribute('aria-modal', 'false');
    expect(onFicha).toHaveBeenLastCalledWith('eventos.E-1');
    expect(screen.getByRole('row', { name: /E-1/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('row', { name: /E-2/ })).toHaveAttribute('aria-selected', 'false');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onFicha).toHaveBeenLastCalledWith(undefined);
    expect(screen.getByRole('button', { name: /Abrir E-1/ })).toHaveFocus();
  });

  it('opens the record the URL names, so a reload or a shared link keeps it', async () => {
    renderHub('todos', vi.fn(), 'admin', { ficha: 'eventos.E-2' });
    expect(await screen.findByRole('dialog', { name: 'Ficha E-2' })).toBeInTheDocument();
    expect(await screen.findByRole('row', { name: /E-2/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // No row opened it, yet Escape still lands on its row instead of the page.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Abrir E-2/ })).toHaveFocus();
  });

  it('moves the selection with the arrows, Home and End, keeping one tab stop in the table', async () => {
    const user = userEvent.setup();
    const onFicha = vi.fn();
    renderHub('todos', vi.fn(), 'admin', { onFicha });
    const grid = await screen.findByRole('grid');
    const openers = await within(grid).findAllByRole('button', { name: /^Abrir / });
    expect(openers.filter((button) => button.tabIndex === 0)).toEqual([openers[0]]);
    openers[0]?.focus();
    await user.keyboard('{ArrowDown}');
    expect(openers[1]).toHaveFocus();
    expect(openers.filter((button) => button.tabIndex === 0)).toEqual([openers[1]]);
    expect(screen.getByRole('row', { name: /E-2/ })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('dialog', { name: 'Ficha E-2' })).toBeInTheDocument();
    expect(onFicha).toHaveBeenLastCalledWith('eventos.E-2');
    await user.keyboard('{End}');
    expect(openers.at(-1)).toHaveFocus();
    await user.keyboard('{Home}');
    expect(openers[0]).toHaveFocus();
    expect(await screen.findByRole('dialog', { name: 'Ficha E-1' })).toBeInTheDocument();
    // At the first row ArrowUp has nowhere to go: the page keeps its own scrolling.
    expect(fireEvent.keyDown(openers[0] as HTMLElement, { key: 'ArrowUp' })).toBe(true);
  });
});

it('keeps write actions off the type screen for read-only roles', async () => {
  renderHub('eventos', vi.fn(), 'consulta');
  expect(await screen.findByRole('button', { name: 'Ver E-1' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Nuevo registro' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Editar E-1' })).not.toBeInTheDocument();
});

/**
 * Type tabs below 1024 px (closure-roadmap T31, direction 01): the same two-line rows as Todos
 * instead of the type's wide table. jsdom has no `matchMedia`, so the width is stubbed.
 */
describe('a type tab below 1024 px', () => {
  const original = window.matchMedia;
  beforeEach(() => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes('width < 64rem'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => {
    window.matchMedia = original;
  });
  const typeList = (label: string) =>
    screen.findByRole('list', { name: `Registros de ${label} del proyecto activo` });

  it('lists Eventos as two-line rows, each one button, with place, date, A–E and status', async () => {
    renderHub('eventos');
    const list = await typeList('eventos');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Densidad de filas' })).not.toBeInTheDocument();
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    const row = within(list).getByRole('button', { name: /^Abrir E-1: Bloqueo del muelle/ });
    expect(within(row.closest('li') as HTMLElement).getAllByRole('button')).toEqual([row]);
    expect(within(row).getByText('Bloqueo del muelle')).toHaveAttribute('data-line', 'title');
    expect(within(row).getByText('Validado')).toHaveAttribute('data-tone', 'positive');
    expect(row.querySelector('[data-line="meta"]')).toHaveTextContent(
      /^Eventos · Bayóvar · 2026-10-28\s*Verificación B$/,
    );
    // The type screen keeps its own actions and search above the rows.
    expect(screen.getByRole('button', { name: 'Nuevo registro' })).toBeInTheDocument();
    expect(screen.getByLabelText('Buscar registros')).toBeInTheDocument();
  });

  it('shows on an Actores row only what the record has: no A–E, status or dashes', async () => {
    renderHub('actores');
    const row = within(await typeList('actores')).getByRole('button', {
      name: /^Abrir A-1: Federación de Pescadores/,
    });
    expect(row.querySelector('[data-line="meta"]')).toHaveTextContent(/^Actores$/);
    expect(row.querySelector('[data-verification]')).toBeNull();
    expect(row.querySelector('[data-tone]')).toBeNull();
    expect(within(row).queryByText('—')).not.toBeInTheDocument();
  });

  it('opens a Demandas row in the modal sheet, names it in the URL and returns to the row', async () => {
    const user = userEvent.setup();
    const onFicha = vi.fn();
    renderHub('demandas', vi.fn(), 'admin', { onFicha });
    const row = within(await typeList('demandas')).getByRole('button', { name: /^Abrir D-1:/ });
    await user.click(row);
    const sheet = await screen.findByRole('dialog', { name: 'Ficha D-1' });
    expect(sheet).toHaveAttribute('aria-modal', 'true');
    expect(onFicha).toHaveBeenLastCalledWith('demandas.D-1');
    await user.keyboard('{Escape}');
    expect(onFicha).toHaveBeenLastCalledWith(undefined);
    expect(row).toHaveFocus();
  });

  it('reopens the record the URL names over the type rows, so a reload keeps it', async () => {
    renderHub('eventos', vi.fn(), 'admin', { ficha: 'eventos.E-2' });
    const sheet = await screen.findByRole('dialog', { name: 'Ficha E-2' });
    expect(sheet).toHaveAttribute('aria-modal', 'true');
    expect(await within(sheet).findByText('Mancha en la playa', { selector: 'dd' })).toBeVisible();
    expect(await typeList('eventos')).toBeInTheDocument();
  });
});

/** Compromisos are a sub-list of the Demandas tab: they open as compromisos, not as demandas. */
describe('a compromiso under the Demandas tab', () => {
  const original = window.matchMedia;
  const width = (phone: boolean) => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes(phone ? 'width < 64rem' : 'min-width: 64rem'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
  };
  afterEach(() => {
    window.matchMedia = original;
  });

  it('opens its own record from «Ver» on desktop and names it in the URL', async () => {
    width(false);
    const user = userEvent.setup();
    const onFicha = vi.fn();
    renderHub('demandas', vi.fn(), 'admin', { onFicha });
    await user.click(await screen.findByRole('button', { name: 'Compromisos' }));
    await user.click(await screen.findByRole('button', { name: 'Ver C-1' }));
    const sheet = await screen.findByRole('dialog', { name: 'Ficha C-1' });
    expect(
      await within(sheet).findByText('Instalar la mesa técnica', { selector: 'dd' }),
    ).toBeVisible();
    expect(within(sheet).getByRole('link', { name: 'Abrir ficha completa' })).toHaveAttribute(
      'href',
      '/objeto/compromisos/C-1',
    );
    expect(onFicha).toHaveBeenLastCalledWith('compromisos.C-1');
  });

  it('opens its own record from its two-line row on a phone', async () => {
    width(true);
    const user = userEvent.setup();
    const onFicha = vi.fn();
    renderHub('demandas', vi.fn(), 'admin', { onFicha });
    await user.click(await screen.findByRole('button', { name: 'Compromisos' }));
    const list = await screen.findByRole('list', {
      name: 'Registros de compromisos del proyecto activo',
    });
    await user.click(within(list).getByRole('button', { name: /^Abrir C-1:/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Ficha C-1' });
    expect(
      await within(sheet).findByText('Instalar la mesa técnica', { selector: 'dd' }),
    ).toBeVisible();
    expect(onFicha).toHaveBeenLastCalledWith('compromisos.C-1');
  });

  it('reopens the compromiso the URL names over the Compromisos sub-list, so a reload keeps it', async () => {
    width(true);
    renderHub('demandas', vi.fn(), 'admin', { ficha: 'compromisos.C-1' });
    const sheet = await screen.findByRole('dialog', { name: 'Ficha C-1' });
    expect(
      await within(sheet).findByText('Instalar la mesa técnica', { selector: 'dd' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Compromisos' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: /^Demandas/, pressed: true })).toBeInTheDocument();
  });

  it('still reopens a demanda the URL names as a demanda, on the Demandas sub-list', async () => {
    width(true);
    renderHub('demandas', vi.fn(), 'admin', { ficha: 'demandas.D-1' });
    const sheet = await screen.findByRole('dialog', { name: 'Ficha D-1' });
    expect(
      await within(sheet).findByText('Revisar la zona de exclusión', { selector: 'dd' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Compromisos' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('ignores a ficha whose type the hub does not show', async () => {
    width(true);
    renderHub('demandas', vi.fn(), 'admin', { ficha: 'acciones.C-1' });
    expect(
      await screen.findByRole('list', { name: 'Registros de demandas del proyecto activo' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

it('keeps the type table with its row actions at 1024 px or wider', async () => {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query.includes('min-width: 64rem'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  try {
    renderHub('eventos');
    expect(await screen.findByRole('button', { name: 'Ver E-1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Editar E-1' })).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Densidad de filas' })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: /^Registros de eventos/ })).not.toBeInTheDocument();
  } finally {
    window.matchMedia = original;
  }
});
