import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../app/query-client.ts';
import { server } from '../../test/server.ts';
import { AccountSection } from './AccountSection.tsx';

// Synthetic credentials only. The Go API says in /system/auth/providers that it changes a
// password; the TypeScript API answers without that flag and has no such route.
type Body = { current_password?: string; new_password?: string };
const CURRENT = 'synthetic-old-pass-1';
const NEXT = 'synthetic-new-pass-22';

const goPasswordRoute = (respond: (body: Body) => Response, posts: Body[] = []) =>
  server.use(
    http.get('*/system/auth/sessions', () => HttpResponse.json({ sessions: [] })),
    http.get('*/system/auth/providers', () =>
      HttpResponse.json({ google: false, password_change: true }),
    ),
    http.post('*/system/auth/password', async ({ request }) => {
      const body = (await request.json()) as Body;
      posts.push(body);
      return respond(body);
    }),
  );

const renderSection = (onSessionEnded = vi.fn()) =>
  render(
    <QueryClientProvider client={createQueryClient(onSessionEnded)}>
      <AccountSection
        scope="ACME/P1"
        username="ana.perez"
        fullName="Ana Pérez Sintética"
        role="analista"
      />
    </QueryClientProvider>,
  );

const fill = async (current: string, next: string, again: string) => {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Contraseña actual'), current);
  await user.type(screen.getByLabelText('Contraseña nueva'), next);
  await user.type(screen.getByLabelText('Repita la contraseña nueva'), again);
  await user.click(screen.getByRole('button', { name: 'Cambiar contraseña' }));
};

describe('PasswordCard', () => {
  it('offers three password fields with the right autocomplete', async () => {
    goPasswordRoute(() => new HttpResponse(null, { status: 204 }));
    renderSection();
    expect(await screen.findByRole('heading', { name: 'Cambiar contraseña' })).toBeInTheDocument();
    const current = screen.getByLabelText('Contraseña actual');
    const next = screen.getByLabelText('Contraseña nueva');
    const again = screen.getByLabelText('Repita la contraseña nueva');
    for (const field of [current, next, again]) expect(field).toHaveAttribute('type', 'password');
    expect(current).toHaveAttribute('autocomplete', 'current-password');
    expect(next).toHaveAttribute('autocomplete', 'new-password');
    expect(again).toHaveAttribute('autocomplete', 'new-password');
  });

  it('refuses two different new passwords without a request', async () => {
    const posts: Body[] = [];
    goPasswordRoute(() => new HttpResponse(null, { status: 204 }), posts);
    renderSection();
    await fill(CURRENT, NEXT, `${NEXT}x`);
    const again = screen.getByLabelText('Repita la contraseña nueva');
    expect(again).toHaveAccessibleDescription('Las contraseñas nuevas no coinciden.');
    expect(again).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(again).toHaveFocus());
    expect(posts).toEqual([]);
  });

  it('confirms the change, says other sessions were closed and clears the fields', async () => {
    const posts: Body[] = [];
    goPasswordRoute(() => new HttpResponse(null, { status: 204 }), posts);
    renderSection();
    await fill(CURRENT, NEXT, NEXT);
    expect(
      await screen.findByText(
        'Contraseña cambiada. Se cerraron las sesiones abiertas en otros dispositivos.',
      ),
    ).toBeInTheDocument();
    expect(posts).toEqual([{ current_password: CURRENT, new_password: NEXT }]);
    expect(screen.getByLabelText('Contraseña actual')).toHaveValue('');
    expect(screen.getByLabelText('Contraseña nueva')).toHaveValue('');
    expect(screen.getByLabelText('Repita la contraseña nueva')).toHaveValue('');
  });

  it('ties a wrong current password (400) to that field and focuses it', async () => {
    goPasswordRoute(() => HttpResponse.json({ detail: 'Credenciales inválidas' }, { status: 400 }));
    renderSection();
    await fill('synthetic-wrong-pass', NEXT, NEXT);
    const current = screen.getByLabelText('Contraseña actual');
    await waitFor(() => expect(current).toHaveAccessibleDescription('Credenciales inválidas'));
    expect(current).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(current).toHaveFocus());
  });

  it('ties a policy refusal (422) to the new password and focuses it', async () => {
    const detail = 'La contraseña nueva debe tener al menos 12 caracteres.';
    goPasswordRoute(() => HttpResponse.json({ detail }, { status: 422 }));
    renderSection();
    await fill(CURRENT, 'short', 'short');
    const next = screen.getByLabelText('Contraseña nueva');
    await waitFor(() => expect(next).toHaveAccessibleDescription(expect.stringContaining(detail)));
    await waitFor(() => expect(next).toHaveFocus());
  });

  it('shows a throttle (429) as a focused message beside the form', async () => {
    const detail = 'Demasiados intentos. Intente nuevamente en unos minutos.';
    goPasswordRoute(() =>
      HttpResponse.json({ detail }, { status: 429, headers: { 'Retry-After': '60' } }),
    );
    renderSection();
    await fill(CURRENT, NEXT, NEXT);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(detail);
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('sends the person to sign in again when the session is gone (401)', async () => {
    const onSessionEnded = vi.fn();
    goPasswordRoute(() =>
      HttpResponse.json({ detail: 'Inicie sesión para acceder a SIPGES' }, { status: 401 }),
    );
    renderSection(onSessionEnded);
    await fill(CURRENT, NEXT, NEXT);
    await waitFor(() => expect(onSessionEnded).toHaveBeenCalled());
  });

  it('is not offered, and never calls the route, where the API does not announce it', async () => {
    const calls: string[] = [];
    server.use(
      http.get('*/system/auth/sessions', () => HttpResponse.json({ sessions: [] })),
      // The TypeScript API's answer: no password_change flag.
      http.get('*/system/auth/providers', () => HttpResponse.json({ google: false })),
      http.post('*/system/auth/password', () => {
        calls.push('password');
        return HttpResponse.json({ detail: 'Not Found' }, { status: 404 });
      }),
    );
    renderSection();
    await screen.findByText('No hay sesiones activas.');
    expect(screen.queryByRole('heading', { name: 'Cambiar contraseña' })).toBeNull();
    expect(screen.queryByLabelText('Contraseña actual')).toBeNull();
    expect(calls).toEqual([]);
  });
});
