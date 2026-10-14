import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { server } from '../../test/server.ts';
import { ProposalsPanel } from './ProposalsPanel.tsx';

const proposal = {
  fingerprint: 'record:acciones:alertas/AL-1',
  kind: 'record',
  title: 'Crear una acción de prevención para la alerta AL-1',
  reason: 'La alerta sigue abierta con nivel Alto y ninguna acción la atiende.',
  link: null,
  record: { module: 'acciones', payload: { Alerta_Asociada: 'AL-1' } },
};

it('approves a proposal and refreshes the list', async () => {
  const user = userEvent.setup();
  let open = [proposal];
  let decided: unknown = null;
  server.use(
    http.get('*/system/briefing/proposals', () => HttpResponse.json(open)),
    http.post('*/system/briefing/proposals', async ({ request }) => {
      decided = await request.json();
      open = [];
      return HttpResponse.json({ ok: true, result: 'acciones/AC-9' });
    }),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ProposalsPanel module="alertas" id="AL-1" scope="ACME/P1" />
    </QueryClientProvider>,
  );
  expect(await screen.findByText(proposal.title)).toBeInTheDocument();
  expect(screen.getByText(proposal.reason)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Aprobar' }));
  expect(
    await screen.findByText('Sin propuestas pendientes para este registro.'),
  ).toBeInTheDocument();
  expect(decided).toEqual({
    module: 'alertas',
    id: 'AL-1',
    fingerprint: proposal.fingerprint,
    decision: 'approve',
  });
});
