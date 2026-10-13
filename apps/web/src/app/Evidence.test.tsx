import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { installRecordsApi } from '../test/records-api.ts';
import { api, resetApi, server } from '../test/server.ts';
import { App } from './App.tsx';

beforeEach(() =>
  resetApi({ me: { username: 'demo', full_name: 'Persona de prueba', role: 'admin' } }),
);
const attachment = {
  id: 'ADJ-1',
  original_name: 'acta.txt',
  content_type: 'text/plain',
  size_bytes: 14,
  sha256: 'a'.repeat(64),
  linked_module: 'fuentes',
  linked_record_id: 'F-1',
  document_type: 'Acta',
  author: 'Persona de prueba',
  verification: 'E - No verificada',
  notes: '',
  project_id: 'PRJ-DEMO',
  project_name: 'Demo',
  created_at: '2026-10-13T12:00:00Z',
  download_url: 'javascript:alert(1)',
};
const openSource = async () => {
  const state = installRecordsApi({
    'DEMO/PRJ-DEMO/fuentes': [{ _id: 'F-1', Archivo_Fuente: 'Acta sintética' }],
  });
  window.history.replaceState(null, '', '/fuentes');
  render(<App />);
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Ver F-1' }));
  return state;
};

describe('linked evidence', () => {
  it('uploads to the saved record and refreshes its attachments without recreating it', async () => {
    await openSource();
    const attachments: (typeof attachment)[] = [];
    let sent: FormData | undefined;
    let scope = '';
    server.use(
      http.get('/system/uploads', ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('linked_module')).toBe('fuentes');
        expect(url.searchParams.get('linked_record_id')).toBe('F-1');
        return HttpResponse.json(attachments);
      }),
      http.post('/system/uploads', async ({ request }) => {
        sent = await request.formData();
        scope = request.headers.get('X-MASCLI-Scope') ?? '';
        attachments.push(attachment);
        return HttpResponse.json({ ok: true, attachment });
      }),
    );
    const user = userEvent.setup();
    await user.upload(
      await screen.findByLabelText('Archivo de evidencia'),
      new File(['Texto de prueba'], 'acta.txt', { type: 'text/plain' }),
    );
    expect(screen.getByRole('button', { name: 'Subir evidencia' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Subir evidencia' }));
    expect(await screen.findByText('acta.txt')).toBeVisible();
    expect(sent?.get('linked_module')).toBe('fuentes');
    expect(sent?.get('linked_record_id')).toBe('F-1');
    expect(scope).toBe('DEMO/PRJ-DEMO');
    expect(await (sent?.get('file') as File).text()).toBe('Texto de prueba');
    expect(api.requests).not.toContain('POST /api/fuentes');
  });

  it('preserves the selected file after a rejected upload and retries on the same record', async () => {
    await openSource();
    let rejected = true;
    server.use(
      http.post('/system/uploads', () =>
        rejected
          ? HttpResponse.json({ detail: 'El archivo supera el límite de 2 MB' }, { status: 413 })
          : HttpResponse.json({ ok: true, attachment }),
      ),
    );
    const user = userEvent.setup();
    await user.upload(
      await screen.findByLabelText('Archivo de evidencia'),
      new File(['Contenido'], 'acta.txt', { type: 'text/plain' }),
    );
    await user.click(screen.getByRole('button', { name: 'Subir evidencia' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'El archivo supera el límite de 2 MB',
    );
    expect(
      (screen.getByLabelText('Archivo de evidencia') as HTMLInputElement).files?.[0]?.name,
    ).toBe('acta.txt');
    rejected = false;
    await user.click(screen.getByRole('button', { name: 'Subir evidencia' }));
    expect(await screen.findByText('Evidencia guardada.')).toBeVisible();
    expect(api.requests.filter((r) => r === 'POST /system/uploads')).toHaveLength(2);
    expect(api.requests).not.toContain('POST /api/fuentes');
  });

  it('downloads only through the scoped API and surfaces missing object errors', async () => {
    await openSource();
    server.use(
      http.get('/system/uploads', () => HttpResponse.json([attachment])),
      http.get('/system/uploads/ADJ-1/download', ({ request }) => {
        expect(request.headers.get('X-MASCLI-Scope')).toBe('DEMO/PRJ-DEMO');
        return HttpResponse.json({ detail: 'El archivo ya no está disponible' }, { status: 410 });
      }),
    );
    // Reopen to refetch after the initial fixture request.
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Cerrar ficha' }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Ver F-1' }));
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Descargar acta.txt' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('El archivo ya no está disponible');
    expect(screen.queryByRole('link', { name: 'acta.txt' })).toBeNull();
  });

  it('allows read-only users to inspect evidence and hides the upload form', async () => {
    api.me = { username: 'lector', full_name: 'Lector', role: 'consulta' };
    await openSource();
    expect(await screen.findByRole('heading', { name: 'Evidencias vinculadas' })).toBeVisible();
    expect(screen.queryByLabelText('Archivo de evidencia')).toBeNull();
  });

  it('returns to sign-in if the upload session expires', async () => {
    await openSource();
    server.use(
      http.post('/system/uploads', () =>
        HttpResponse.json({ detail: 'Inicie sesión' }, { status: 401 }),
      ),
    );
    const user = userEvent.setup();
    await user.upload(
      await screen.findByLabelText('Archivo de evidencia'),
      new File(['Texto'], 'acta.txt', { type: 'text/plain' }),
    );
    await user.click(screen.getByRole('button', { name: 'Subir evidencia' }));
    expect(await screen.findByLabelText('Usuario')).toBeVisible();
  });
});

it('keeps a pending upload scoped to the original tenant after a project switch', async () => {
  api.scopes.push({ company_id: 'DEMO', project_id: 'PRJ-NORTE', label: 'Proyecto Norte' });
  const state = await openSource();
  state.rows['DEMO/PRJ-NORTE/fuentes'] = [{ _id: 'F-1', Archivo_Fuente: 'Fuente Norte' }];
  let release: () => void = () => undefined;
  let started = false;
  let uploadScope: string | null = null;
  server.use(
    http.post('/system/uploads', async ({ request }) => {
      uploadScope = request.headers.get('X-MASCLI-Scope');
      started = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return HttpResponse.json({ ok: true, attachment });
    }),
  );
  const user = userEvent.setup();
  await user.upload(
    await screen.findByLabelText('Archivo de evidencia'),
    new File(['Texto'], 'acta.txt', { type: 'text/plain' }),
  );
  await user.click(screen.getByRole('button', { name: 'Subir evidencia' }));
  await waitFor(() => expect(started).toBe(true));
  await user.selectOptions(screen.getByLabelText('Proyecto activo'), 'DEMO/PRJ-NORTE');
  expect(await screen.findByText('Fuente Norte')).toBeVisible();
  release();
  await waitFor(() => expect(screen.queryByLabelText('Archivo de evidencia')).toBeNull());
  expect(uploadScope).toBe('DEMO/PRJ-DEMO');
  expect(screen.queryByText('Evidencia guardada.')).toBeNull();
});

it('blocks record editing and deletion while its evidence upload is pending', async () => {
  await openSource();
  let release: () => void = () => undefined;
  let started = false;
  server.use(
    http.post('/system/uploads', async () => {
      started = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return HttpResponse.json({ ok: true, attachment });
    }),
  );
  const user = userEvent.setup();
  await user.upload(
    await screen.findByLabelText('Archivo de evidencia'),
    new File(['Texto'], 'acta.txt', { type: 'text/plain' }),
  );
  await user.click(screen.getByRole('button', { name: 'Subir evidencia' }));
  await waitFor(() => expect(started).toBe(true));
  try {
    expect(screen.getByRole('button', { name: 'Editar F-1' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Eliminar F-1' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cerrar ficha' })).toBeDisabled();
  } finally {
    release();
  }
});
