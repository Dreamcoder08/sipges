import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../test/server.ts';
import { AccountSection } from './AccountSection.tsx';

// Regression probes from the independent review of Cuenta (compact-sidebar T4). Synthetic
// sessions only; ids are opaque 32-hex strings, never tokens.
const THIS = 'a'.repeat(32);
const LAPTOP = 'b'.repeat(32);
const PHONE = 'c'.repeat(32);
const session = (id: string, created: string, current = false) => ({
  id,
  created_at: created,
  expires_at: created.replace('T1', 'T2'),
  method: 'password',
  current,
});
const THIS_SESSION = session(THIS, '2026-11-12T11:00:00Z', true);
const LAPTOP_SESSION = session(LAPTOP, '2026-11-12T10:00:00Z');
const PHONE_SESSION = session(PHONE, '2026-11-12T12:00:00Z');

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
        role="consulta"
      />
    </QueryClientProvider>,
  );

describe('AccountSectionProbes', () => {
  it('reloads the list when the session to end was already gone (404)', async () => {
    const user = userEvent.setup();
    let sessions = [PHONE_SESSION, THIS_SESSION, LAPTOP_SESSION];
    let reads = 0;
    server.use(
      http.get('*/system/auth/sessions', () => {
        reads += 1;
        return HttpResponse.json({ sessions });
      }),
      http.delete('*/system/auth/sessions/:id', () => {
        // Ended elsewhere (another device, «todos los demás») since the list was read.
        sessions = sessions.filter((s) => s.id !== LAPTOP);
        return HttpResponse.json({ detail: 'Sesión inexistente' }, { status: 404 });
      }),
    );
    renderSection();
    const list = await screen.findByRole('list', { name: 'Sesiones activas' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    const laptop = within(list)
      .getAllByRole('button', { name: /^Cerrar sesión iniciada/ })
      .at(-1);
    await user.click(laptop as HTMLElement);
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Cerrar sesión',
      }),
    );

    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
    expect(reads).toBe(2);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(await screen.findByText('Esa sesión ya estaba cerrada.')).toBeInTheDocument();
    expect(screen.queryByText('Sesión cerrada.')).toBeNull();
  });

  it('pins both writes to the scope the section was opened in', async () => {
    const user = userEvent.setup();
    const writes: [string, string | null][] = [];
    let sessions = [PHONE_SESSION, THIS_SESSION, LAPTOP_SESSION];
    server.use(
      http.get('*/system/auth/sessions', () => HttpResponse.json({ sessions })),
      http.delete('*/system/auth/sessions/:id', ({ request, params }) => {
        writes.push([`DELETE ${String(params.id)}`, request.headers.get('x-sipges-scope')]);
        sessions = sessions.filter((s) => s.id !== params.id);
        return HttpResponse.json({ ok: true, current: false });
      }),
      http.post('*/system/auth/sessions/revoke-others', ({ request }) => {
        writes.push(['POST revoke-others', request.headers.get('x-sipges-scope')]);
        sessions = sessions.filter((s) => s.current);
        return HttpResponse.json({ ok: true, count: 1 });
      }),
    );
    renderSection();
    const list = await screen.findByRole('list', { name: 'Sesiones activas' });
    await user.click(
      within(list)
        .getAllByRole('button', { name: /^Cerrar sesión iniciada/ })
        .at(-1) as HTMLElement,
    );
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Cerrar sesión',
      }),
    );
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
    await user.click(screen.getByRole('button', { name: 'Cerrar sesión en todos los demás' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Cerrar las demás sesiones',
      }),
    );
    expect(await screen.findByText('No hay otras sesiones abiertas.')).toBeInTheDocument();
    expect(writes).toEqual([
      [`DELETE ${LAPTOP}`, 'ACME/P1'],
      ['POST revoke-others', 'ACME/P1'],
    ]);
  });

  it('speaks in the singular when one other session is open', async () => {
    const user = userEvent.setup();
    let sessions = [THIS_SESSION, LAPTOP_SESSION];
    server.use(
      http.get('*/system/auth/sessions', () => HttpResponse.json({ sessions })),
      http.post('*/system/auth/sessions/revoke-others', () => {
        sessions = [THIS_SESSION];
        return HttpResponse.json({ ok: true, count: 1 });
      }),
    );
    renderSection();
    await user.click(
      await screen.findByRole('button', { name: 'Cerrar sesión en todos los demás' }),
    );
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText(
        'Se cerrará 1 sesión abierta en otro dispositivo. Este dispositivo sigue conectado.',
      ),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cerrar las demás sesiones' }));
    expect(await screen.findByText('Se cerró 1 sesión en otro dispositivo.')).toBeInTheDocument();
  });
});
