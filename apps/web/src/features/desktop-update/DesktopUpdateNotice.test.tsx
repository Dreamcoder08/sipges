import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, resetApi, server } from '../../test/server.ts';
import { App } from '../../app/App.tsx';
import { DESKTOP_MARKER, DesktopUpdateNotice } from './DesktopUpdateNotice.tsx';

const PATH = '/system/desktop/update';
const NOTES = 'Corrige el filtro de registros.\nNuevo resumen semanal.';

type Status = { installed: string | null; available: string | null; notes: string | null };

/** A synthetic desktop API: what the launcher verified, plus every call the notice made. */
const desktopApi = (initial: Status, options: { status?: number } = {}) => {
  const state = { ...initial, dismissed: false, down: false };
  const calls: string[] = [];
  server.use(
    http.get(PATH, () => {
      calls.push('GET');
      if (options.status) return HttpResponse.json({ detail: 'x' }, { status: options.status });
      if (state.down) return HttpResponse.error();
      return HttpResponse.json({
        installed: state.installed,
        available: state.available,
        notes: state.notes,
        dismissed: state.dismissed,
      });
    }),
    http.post(PATH, () => {
      calls.push('POST update');
      return HttpResponse.json({ status: 'restarting', version: state.available }, { status: 202 });
    }),
    http.post(`${PATH}/dismiss`, () => {
      calls.push('POST dismiss');
      state.dismissed = true;
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return { state, calls };
};

const markDesktop = () => {
  const meta = document.createElement('meta');
  meta.name = DESKTOP_MARKER;
  meta.content = '1';
  document.head.append(meta);
};

afterEach(() => {
  document.head.querySelectorAll(`meta[name="${DESKTOP_MARKER}"]`).forEach((m) => m.remove());
});

const renderNotice = (props: { onUpdated?: () => void } = {}) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <DesktopUpdateNotice scope="DEMO/PRJ-DEMO" pollMs={20} {...props} />
    </QueryClientProvider>,
  );

const notice = () => screen.queryByRole('region', { name: /Nueva versión de SIPGES/ });

describe('rule 1: shown only when a newer signed version exists', () => {
  it('shows the new version, what changed and both choices', async () => {
    markDesktop();
    desktopApi({ installed: '1.0.0', available: '1.1.0', notes: NOTES });
    renderNotice();
    const region = await screen.findByRole('region', { name: 'Nueva versión de SIPGES: 1.1.0' });
    expect(region).toHaveTextContent('Tienes la versión 1.0.0.');
    expect(region).toHaveTextContent('Qué cambió');
    expect(region).toHaveTextContent('Corrige el filtro de registros.');
    expect(region).toHaveTextContent('Nuevo resumen semanal.');
    expect(screen.getByRole('button', { name: 'Actualizar' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Ahora no' })).toBeEnabled();
  });

  it('shows nothing when the launcher verified no newer version (older or tampered too)', async () => {
    markDesktop();
    const { calls } = desktopApi({ installed: '1.0.0', available: null, notes: null });
    renderNotice();
    await waitFor(() => expect(calls).toEqual(['GET']));
    expect(notice()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Actualizar' })).toBeNull();
  });

  it('installs nothing before the click, then asks once and says SIPGES restarts', async () => {
    markDesktop();
    const { state, calls } = desktopApi({ installed: '1.0.0', available: '1.1.0', notes: null });
    const onUpdated = vi.fn();
    renderNotice({ onUpdated });
    await screen.findByRole('region', { name: /Nueva versión/ });
    expect(calls).toEqual(['GET']);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Actualizar' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Actualizando a la versión 1.1.0. SIPGES se reiniciará',
    );
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual(['POST update']);
    // The launcher stops the server, updates it and starts the new version.
    state.down = true;
    await waitFor(() => expect(calls.length).toBeGreaterThan(3));
    expect(onUpdated).not.toHaveBeenCalled();
    Object.assign(state, { down: false, installed: '1.1.0', available: null });
    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1));
  });

  it('says the update failed when SIPGES comes back on the old version', async () => {
    markDesktop();
    const { state } = desktopApi({ installed: '1.0.0', available: '1.1.0', notes: null });
    const onUpdated = vi.fn();
    renderNotice({ onUpdated });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Actualizar' }));
    state.down = true;
    await new Promise((resolve) => setTimeout(resolve, 100));
    state.down = false;
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No se pudo completar la actualización. Sigues usando la versión 1.0.0.',
    );
    expect(onUpdated).not.toHaveBeenCalled();
  });
});

describe('rule 2: declining', () => {
  it('keeps the current version and does not ask again until the next start', async () => {
    markDesktop();
    const { calls } = desktopApi({ installed: '1.0.0', available: '1.1.0', notes: null });
    const first = renderNotice();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Ahora no' }));
    expect(notice()).toBeNull();
    await waitFor(() => expect(calls).toContain('POST dismiss'));
    expect(calls).not.toContain('POST update');
    // Another screen or a reload in the same run of SIPGES: still hidden.
    first.unmount();
    const before = calls.length;
    renderNotice();
    await waitFor(() => expect(calls.length).toBe(before + 1));
    expect(notice()).toBeNull();
  });
});

describe('rule 3: cloud and development builds', () => {
  it('asks nothing and shows nothing without the desktop marker', async () => {
    const { calls } = desktopApi({ installed: '1.0.0', available: '1.1.0', notes: null });
    renderNotice();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toEqual([]);
    expect(notice()).toBeNull();
  });

  it('shows nothing when the server has no desktop update routes', async () => {
    markDesktop();
    const { calls } = desktopApi(
      { installed: '1.0.0', available: '1.1.0', notes: null },
      { status: 404 },
    );
    renderNotice();
    await waitFor(() => expect(calls).toEqual(['GET']));
    expect(notice()).toBeNull();
  });
});

describe('rule 4: only administrators', () => {
  it('shows nothing to a role the server refuses', async () => {
    markDesktop();
    const { calls } = desktopApi(
      { installed: '1.0.0', available: '1.1.0', notes: null },
      { status: 403 },
    );
    renderNotice();
    await waitFor(() => expect(calls).toEqual(['GET']));
    expect(notice()).toBeNull();
  });
});

describe('in the app shell', () => {
  beforeEach(() => resetApi());

  it('appears above every signed-in screen of the desktop build', async () => {
    markDesktop();
    desktopApi({ installed: '1.0.0', available: '1.1.0', notes: NOTES });
    api.me = { username: 'persona', full_name: 'Persona Sintética', role: 'admin' };
    window.history.replaceState(null, '', '/inicio');
    render(<App />);
    await screen.findByRole('navigation', { name: 'Secciones' });
    expect(
      await screen.findByRole('region', { name: 'Nueva versión de SIPGES: 1.1.0' }),
    ).toBeInTheDocument();
  });
});
