import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { server } from '../../test/server.ts';
import { AccountSection } from './AccountSection.tsx';

// Synthetic sessions only; ids are opaque 32-hex strings, never tokens.
const THIS = 'a'.repeat(32);
const LAPTOP = 'b'.repeat(32);
const PHONE = 'c'.repeat(32);
const session = (id: string, created: string, current = false, method = 'password') => ({
  id,
  created_at: created,
  expires_at: created.replace('T1', 'T2'),
  method,
  current,
});
const three = () => ({
  sessions: [
    session(PHONE, '2026-11-12T12:00:00Z', false, 'google'),
    session(THIS, '2026-11-12T11:00:00Z', true),
    session(LAPTOP, '2026-11-12T10:00:00Z'),
  ],
});

const renderSection = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <AccountSection
        scope="ACME/P1"
        username="ana.perez"
        fullName="Ana Pérez Sintética"
        role="analista"
      />
    </QueryClientProvider>,
  );

it('shows the signed-in user and every session, with this device marked', async () => {
  const scopes: (string | null)[] = [];
  server.use(
    http.get('*/system/auth/sessions', ({ request }) => {
      scopes.push(request.headers.get('x-sipges-scope'));
      return HttpResponse.json(three());
    }),
  );
  renderSection();
  expect(screen.getByRole('heading', { name: 'Cuenta' })).toBeInTheDocument();
  expect(screen.getByText('Ana Pérez Sintética')).toBeInTheDocument();
  expect(screen.getByText('ana.perez')).toBeInTheDocument();
  expect(screen.getByText('Analista')).toBeInTheDocument();

  const list = await screen.findByRole('list', { name: 'Sesiones activas' });
  const items = within(list).getAllByRole('listitem');
  expect(items).toHaveLength(3);
  expect(within(items[0] as HTMLElement).getByText(/Google/)).toBeInTheDocument();
  expect(within(items[1] as HTMLElement).getByText('Este dispositivo')).toBeInTheDocument();
  expect(within(list).getAllByText('Este dispositivo')).toHaveLength(1);
  // This device is signed out from the account menu, not from here.
  expect(within(items[1] as HTMLElement).queryByRole('button')).not.toBeInTheDocument();
  expect(within(list).getAllByRole('button', { name: /^Cerrar sesión iniciada/ })).toHaveLength(2);
  expect(screen.getByRole('button', { name: 'Cerrar sesión en todos los demás' })).toBeEnabled();
  expect(scopes).toEqual(['ACME/P1']);
});

it('ends one other session after confirming, then reloads the list', async () => {
  const user = userEvent.setup();
  let current = three();
  const deleted: string[] = [];
  server.use(
    http.get('*/system/auth/sessions', () => HttpResponse.json(current)),
    http.delete('*/system/auth/sessions/:id', ({ params }) => {
      deleted.push(String(params.id));
      current = { sessions: current.sessions.filter((s) => s.id !== params.id) };
      return HttpResponse.json({ ok: true, current: false });
    }),
  );
  renderSection();
  const list = await screen.findByRole('list', { name: 'Sesiones activas' });
  const [laptop] = within(list)
    .getAllByRole('button', { name: /^Cerrar sesión iniciada/ })
    .slice(-1);
  await user.click(laptop as HTMLElement);

  const dialog = await screen.findByRole('alertdialog', { name: 'Cerrar esta sesión' });
  await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
  expect(deleted).toEqual([]);

  await user.click(laptop as HTMLElement);
  await user.click(
    within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cerrar sesión' }),
  );
  expect(await screen.findByText('Sesión cerrada.')).toBeInTheDocument();
  expect(deleted).toEqual([LAPTOP]);
  await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
});

it('signs out every other device after confirming and says how many', async () => {
  const user = userEvent.setup();
  let current = three();
  let revoked = 0;
  server.use(
    http.get('*/system/auth/sessions', () => HttpResponse.json(current)),
    http.post('*/system/auth/sessions/revoke-others', () => {
      revoked += 1;
      current = { sessions: current.sessions.filter((s) => s.current) };
      return HttpResponse.json({ ok: true, count: 2 });
    }),
  );
  renderSection();
  await user.click(await screen.findByRole('button', { name: 'Cerrar sesión en todos los demás' }));
  const dialog = await screen.findByRole('alertdialog', {
    name: 'Cerrar sesión en todos los demás dispositivos',
  });
  expect(within(dialog).getByText(/2 sesiones/)).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Cerrar las demás sesiones' }));
  expect(
    await screen.findByText('Se cerraron 2 sesiones en otros dispositivos.'),
  ).toBeInTheDocument();
  expect(revoked).toBe(1);
  expect(await screen.findByText('No hay otras sesiones abiertas.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Cerrar sesión en todos los demás' })).toBeNull();
});

it('keeps the dialog open with the error when ending fails', async () => {
  const user = userEvent.setup();
  server.use(
    http.get('*/system/auth/sessions', () => HttpResponse.json(three())),
    http.post('*/system/auth/sessions/revoke-others', () =>
      HttpResponse.json({ detail: 'Seleccione un proyecto autorizado' }, { status: 403 }),
    ),
  );
  renderSection();
  await user.click(await screen.findByRole('button', { name: 'Cerrar sesión en todos los demás' }));
  const dialog = await screen.findByRole('alertdialog');
  await user.click(within(dialog).getByRole('button', { name: 'Cerrar las demás sesiones' }));
  expect(await within(dialog).findByText('Seleccione un proyecto autorizado')).toBeInTheDocument();
});

it('shows a loading state, then an error with a retry that recovers', async () => {
  const user = userEvent.setup();
  let fail = true;
  server.use(
    http.get('*/system/auth/sessions', () =>
      fail
        ? HttpResponse.json({ detail: 'Error interno' }, { status: 500 })
        : HttpResponse.json(three()),
    ),
  );
  renderSection();
  expect(screen.getByText(/Cargando las sesiones activas/)).toBeInTheDocument();
  expect(await screen.findByText('Error interno')).toBeInTheDocument();
  fail = false;
  await user.click(screen.getByRole('button', { name: 'Reintentar' }));
  expect(await screen.findByRole('list', { name: 'Sesiones activas' })).toBeInTheDocument();
});

it('says when this is the only open session', async () => {
  server.use(
    http.get('*/system/auth/sessions', () =>
      HttpResponse.json({ sessions: [session(THIS, '2026-11-12T11:00:00Z', true)] }),
    ),
  );
  renderSection();
  expect(await screen.findByText('No hay otras sesiones abiertas.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Cerrar sesión en todos los demás' })).toBeNull();
});
