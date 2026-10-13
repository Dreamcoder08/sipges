import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, expect, it } from 'vitest';
import { server, resetApi } from '../test/server.ts';
import { App } from './App.tsx';

beforeEach(() =>
  resetApi({ me: { username: 'mfa-reader', full_name: 'Lectura sintética', role: 'consulta' } }),
);
it('enrolls MFA before requiring a project, even for a consultation account', async () => {
  let enabled = false;
  server.use(
    http.get('/system/auth/current-scope', () =>
      enabled
        ? HttpResponse.json({ company_id: 'DEMO', project_id: 'PRJ-DEMO', scope: 'DEMO/PRJ-DEMO' })
        : HttpResponse.json({ detail: 'Active MFA', mfa_required: true }, { status: 403 }),
    ),
    http.post('/system/auth/totp/setup', () =>
      HttpResponse.json({
        secret: 'TEST-SYNTHETIC-TOTP',
        otpauth_uri: 'otpauth://totp/demo?secret=TEST',
        instruction: 'Synthetic setup',
      }),
    ),
    http.post('/system/auth/totp/enable', async ({ request }) => {
      const { code } = (await request.json()) as { code: string };
      if (code !== '123456')
        return HttpResponse.json({ detail: 'Código inválido' }, { status: 422 });
      enabled = true;
      return HttpResponse.json({ ok: true, totp_enabled: true });
    }),
  );
  window.history.replaceState(null, '', '/');
  render(<App />);
  expect(
    await screen.findByRole('heading', { level: 1, name: 'Configurar autenticación multifactor' }),
  ).toBeVisible();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Preparar autenticador' }));
  expect(await screen.findByText('TEST-SYNTHETIC-TOTP')).toBeVisible();
  await user.type(screen.getByLabelText('Código del autenticador'), '000000');
  await user.click(screen.getByRole('button', { name: 'Activar y continuar' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Código inválido');
  expect(screen.getByText('TEST-SYNTHETIC-TOTP')).toBeVisible();
  await user.clear(screen.getByLabelText('Código del autenticador'));
  await user.type(screen.getByLabelText('Código del autenticador'), '123456');
  await user.click(screen.getByRole('button', { name: 'Activar y continuar' }));
  expect(
    await screen.findByRole('heading', { level: 1, name: 'Dashboard ejecutivo' }),
  ).toBeVisible();
  expect(screen.queryByText('TEST-SYNTHETIC-TOTP')).toBeNull();
});
