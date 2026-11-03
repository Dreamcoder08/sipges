import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, expect, it } from 'vitest';
import { server, resetApi } from '../test/server.ts';
import { App } from './App.tsx';

const ME = { username: 'analista', full_name: 'Analista sintética', role: 'analista' } as const;

beforeEach(() => resetApi({ me: ME }));

it('asks for the session and the active project together on load', async () => {
  // Each request is a round trip to a distant server; waiting for one before the other
  // doubles the time before the first screen can draw.
  let scopeAsked = false;
  let scopeAskedBeforeSessionAnswered: boolean | undefined;
  server.use(
    http.get('/system/auth/current-scope', () => {
      scopeAsked = true;
      return HttpResponse.json({
        company_id: 'DEMO',
        project_id: 'PRJ-DEMO',
        scope: 'DEMO/PRJ-DEMO',
      });
    }),
    http.get('/system/auth/me', async () => {
      for (let i = 0; i < 10 && !scopeAsked; i++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      scopeAskedBeforeSessionAnswered ??= scopeAsked;
      return HttpResponse.json({ ...ME, active: 1 });
    }),
  );
  window.history.replaceState(null, '', '/');
  render(<App />);
  expect(await screen.findByRole('heading', { level: 1 }, { timeout: 4_000 })).toBeVisible();
  expect(scopeAskedBeforeSessionAnswered).toBe(true);
});

it('still sends a visitor without a session to the sign-in page', async () => {
  resetApi({ me: null });
  window.history.replaceState(null, '', '/');
  render(<App />);
  expect(await screen.findByRole('button', { name: /ingresar|iniciar sesión/i })).toBeVisible();
});
