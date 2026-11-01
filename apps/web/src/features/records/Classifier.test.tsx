import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it, vi } from 'vitest';
import { server } from '../../test/server.ts';
import { RecordEditor } from './RecordEditor.tsx';
const result = {
  classifier_version: '2.4',
  dimension: 'E',
  dimension_label: 'Ambiental-territorial',
  confidence: 80,
  nivel_sugerido: 'Amarillo',
  scores: { E: 5 },
  margin: 3,
  evidence: { E: [{ signal: 'agua', weight: 5 }] },
  review_required: true,
  nota: 'Clasificación provisional: revisión.',
};
const open = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
    >
      <RecordEditor
        module="eventos"
        scope="A/B"
        pending={false}
        error={null}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />
    </QueryClientProvider>,
  );
it('classifies the current draft within scope and applies the suggestion only on request', async () => {
  let scope: string | null = null;
  server.use(
    http.post('/system/analyze', ({ request }) => {
      scope = request.headers.get('X-SIPGES-Scope');
      return HttpResponse.json(result);
    }),
  );
  open();
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Descripción del hecho'), 'Agua para comunidad');
  await user.click(screen.getByRole('button', { name: 'Analizar dimensión' }));
  await screen.findByText(result.nota);
  expect(scope).toBe('A/B');
  expect(screen.getByLabelText('Dimensión principal')).toHaveValue('');
  await user.click(screen.getByRole('button', { name: 'Aplicar dimensión sugerida' }));
  expect(screen.getByLabelText('Dimensión principal')).toHaveValue('E - Ambiental-territorial');
});
it('discards a classifier response when the draft changes during analysis', async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.use(
    http.post('/system/analyze', async () => {
      await held;
      return HttpResponse.json(result);
    }),
  );
  open();
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Descripción del hecho'), 'Agua');
  await user.click(screen.getByRole('button', { name: 'Analizar dimensión' }));
  await user.type(screen.getByLabelText('Descripción del hecho'), ' nuevo contexto');
  release();
  await screen.findByRole('button', { name: 'Analizar dimensión' });
  expect(screen.queryByRole('button', { name: 'Aplicar dimensión sugerida' })).toBeNull();
  expect(screen.getByLabelText('Dimensión principal')).toHaveValue('');
});
