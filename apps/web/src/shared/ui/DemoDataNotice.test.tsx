import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../test/server.ts';
import { DemoDataNotice } from './DemoDataNotice.tsx';

const counters = (n: number) => ({
  eventos: n,
  actores: 0,
  demandas_abiertas: 0,
  alertas_activas: 0,
  directorio: 0,
  priorizados: 0,
});
const mount = (demo: number) => {
  server.use(
    http.get('*/api/dashboard', () =>
      HttpResponse.json({ ...counters(1), niveles: {}, demostracion: counters(demo) }),
    ),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DemoDataNotice scope="DEMO/PRJ-DEMO" />
      <p>Análisis</p>
    </QueryClientProvider>,
  );
};

describe('DemoDataNotice', () => {
  it('tells that an analysis also reads the synthetic case', async () => {
    mount(20);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'también usa los registros de demostración',
    );
  });

  it('stays silent when the project has only real records', async () => {
    mount(0);
    await screen.findByText('Análisis');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('status')).toBeNull();
  });
});
