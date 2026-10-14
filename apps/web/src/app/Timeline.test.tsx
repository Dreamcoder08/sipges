import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, expect, it } from 'vitest';
import { installRecordsApi } from '../test/records-api.ts';
import { resetApi, server } from '../test/server.ts';
import { App } from './App.tsx';

beforeEach(() =>
  resetApi({ me: { username: 'demo', full_name: 'Persona de prueba', role: 'admin' } }),
);

const entry = (module: string, id: string, title: string, date: string, marking = 'interno') => ({
  module,
  id,
  type_label: module === 'eventos' ? 'Evento' : 'Demanda',
  title,
  date,
  marking,
  fields: {},
});

it('lists dated records by month, filters by type and period, and opens a record', async () => {
  installRecordsApi();
  const requests: string[] = [];
  const all = [
    entry('demandas', 'D-1', 'Agua potable', '2026-10-02'),
    entry('eventos', 'EV-2', 'Paro', '2026-10-01', 'restringido'),
    entry('eventos', 'EV-1', 'Asamblea', '2026-08-15'),
  ];
  server.use(
    http.get('/system/timeline', ({ request }) => {
      const url = new URL(request.url);
      requests.push(url.search);
      const from = url.searchParams.get('from') ?? '';
      const to = url.searchParams.get('to') ?? '';
      const modules = url.searchParams.get('modules')?.split(',') ?? [];
      const entries = all.filter(
        (e) =>
          (!modules.length || modules.includes(e.module)) &&
          (!from || e.date.slice(0, 7) >= from) &&
          (!to || e.date.slice(0, 7) <= to),
      );
      return HttpResponse.json({ from, to, entries, truncated: false });
    }),
  );
  window.history.replaceState(null, '', '/cronologia');
  render(<App />);
  const user = userEvent.setup();
  expect(await screen.findByRole('heading', { name: /Octubre de 2026/ })).toBeVisible();
  const october = screen.getByRole('region', { name: /Octubre de 2026/ });
  expect(within(october).getAllByRole('listitem')).toHaveLength(2);
  expect(within(october).getByText('Restringido')).toBeVisible();
  expect(screen.getByRole('heading', { name: /Agosto de 2026/ })).toBeVisible();

  await user.click(screen.getByRole('button', { name: 'Agosto de 2026: 1 registro' }));
  await screen.findByText(/Periodo: Agosto de 2026/);
  expect(await screen.findByRole('link', { name: 'Asamblea' })).toBeVisible();
  expect(screen.queryByRole('link', { name: 'Paro' })).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Ver todo el periodo' }));
  await user.click(screen.getByRole('checkbox', { name: 'Demandas' }));
  await screen.findByRole('link', { name: 'Agua potable' });
  expect(screen.queryByRole('link', { name: 'Asamblea' })).toBeNull();
  expect(requests.some((q) => q.includes('modules=demandas'))).toBe(true);

  await user.click(screen.getByRole('link', { name: 'Agua potable' }));
  expect(window.location.pathname).toBe('/objeto/demandas/D-1');
});
