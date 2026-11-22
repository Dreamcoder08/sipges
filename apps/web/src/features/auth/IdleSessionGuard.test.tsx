import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_HEADER, request } from '../../shared/api/client.ts';
import { resetApi, server } from '../../test/server.ts';
import { IdleSessionGuard } from './IdleSessionGuard.tsx';

const MINUTE = 60_000;
const TIMEOUT_SECONDS = 30 * 60;

/** Keepalives sent: GET /system/auth/sessions, with their background header. */
const keepalives: (string | null)[] = [];
const record = ({ request }: { request: Request }) => {
  if (new URL(request.url).pathname === '/system/auth/sessions') {
    keepalives.push(request.headers.get(BACKGROUND_HEADER));
  }
};

// jsdom has no modal dialogs nor `method="dialog"` forms; these stand in for the browser.
const closeOnDialogSubmit = (event: Event) => {
  const form = event.target as HTMLFormElement;
  if (form.method !== 'dialog') return;
  event.preventDefault();
  form.closest('dialog')?.close();
};
const original = {
  showModal: HTMLDialogElement.prototype.showModal,
  close: HTMLDialogElement.prototype.close,
};
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
  document.addEventListener('submit', closeOnDialogSubmit);
});
afterAll(() => {
  Object.assign(HTMLDialogElement.prototype, original);
  document.removeEventListener('submit', closeOnDialogSubmit);
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  resetApi({ me: { username: 'persona', full_name: 'Persona Sintética', role: 'admin' } });
  keepalives.length = 0;
  server.events.on('request:start', record);
});
afterEach(() => {
  server.events.removeListener('request:start', record);
  vi.useRealTimers();
});

const withTimeout = (seconds: number | undefined) =>
  server.use(
    http.get('/system/auth/providers', () =>
      HttpResponse.json(
        seconds === undefined
          ? { google: false }
          : { google: false, idle_timeout_seconds: seconds },
      ),
    ),
  );

const mount = async (onExpired = vi.fn()) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <IdleSessionGuard onExpired={onExpired} />
    </QueryClientProvider>,
  );
  // Let the providers answer arrive before the clock moves.
  await act(() => vi.advanceTimersByTimeAsync(50));
  return onExpired;
};

const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const touch = () => fireEvent.pointerDown(document);

describe('idle session (world-class-local T8f)', () => {
  it('does nothing when the API announces no idle timeout', async () => {
    withTimeout(undefined);
    const expired = await mount();
    await wait(10 * MINUTE);
    touch();
    await wait(40 * MINUTE);
    touch();
    await wait(MINUTE);
    expect(keepalives).toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(expired).not.toHaveBeenCalled();
  });

  it('sends one keepalive on activity only once five minutes passed since the last request', async () => {
    withTimeout(TIMEOUT_SECONDS);
    await mount();
    await wait(4 * MINUTE);
    touch();
    await wait(100);
    expect(keepalives).toEqual([]);
    await wait(2 * MINUTE);
    touch();
    fireEvent.keyDown(document, { key: 'a' });
    await wait(100);
    expect(keepalives).toEqual([null]);
    // The keepalive is the newest request: the next one waits another five minutes.
    await wait(4 * MINUTE);
    touch();
    await wait(100);
    expect(keepalives).toEqual([null]);
  });

  it('keeps the session of someone typing for an hour', async () => {
    withTimeout(TIMEOUT_SECONDS);
    const expired = await mount();
    for (let minute = 0; minute < 60; minute += 1) {
      fireEvent.keyDown(document, { key: 'a' });
      await wait(MINUTE);
    }
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(expired).not.toHaveBeenCalled();
    expect(keepalives.length).toBeGreaterThanOrEqual(10);
  });

  it('warns two minutes before the deadline, and «Seguir conectado» keeps the session', async () => {
    withTimeout(TIMEOUT_SECONDS);
    const expired = await mount();
    await wait(27 * MINUTE + 50 * 1000);
    expect(screen.queryByRole('dialog')).toBeNull();
    await wait(20 * 1000);
    const dialog = screen.getByRole('dialog', { name: 'Su sesión está por cerrarse' });
    expect(dialog).toHaveTextContent(
      'Por inactividad, la sesión se cerrará en 2 minutos. Lo que no haya guardado se perderá.',
    );
    const stay = screen.getByRole('button', { name: 'Seguir conectado' });
    expect(stay).toHaveFocus();

    // Activity alone does not dismiss it.
    touch();
    fireEvent.keyDown(document, { key: 'a' });
    await wait(100);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(keepalives).toEqual([]);

    fireEvent.click(stay);
    await wait(100);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(keepalives).toEqual([null]);
    // The deadline now counts from the keepalive.
    await wait(27 * MINUTE);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(expired).not.toHaveBeenCalled();
    await wait(MINUTE + 10 * 1000);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('measures the deadline from user requests, not from /system/auth/me or polling', async () => {
    withTimeout(TIMEOUT_SECONDS);
    server.use(http.get('/user-probe', () => HttpResponse.json({ ok: true })));
    await mount();
    await wait(10 * MINUTE);
    await act(() => request('/system/auth/me'));
    await act(() => request('/user-probe', { background: true }));
    await wait(18 * MINUTE + 10 * 1000);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    cleanup();

    await mount();
    await wait(10 * MINUTE);
    await act(() => request('/user-probe'));
    await wait(18 * MINUTE + 10 * 1000);
    expect(screen.queryByRole('dialog')).toBeNull();
    await wait(10 * MINUTE);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('treats Escape as continuing', async () => {
    withTimeout(TIMEOUT_SECONDS);
    const expired = await mount();
    await wait(28 * MINUTE + 10 * 1000);
    const dialog = screen.getByRole('dialog');
    // What the browser does on Escape: a cancel event, then the dialog closes.
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    (dialog as HTMLDialogElement).close();
    await wait(100);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(keepalives).toEqual([null]);
    await wait(5 * MINUTE);
    expect(expired).not.toHaveBeenCalled();
  });

  it('ends the session at the deadline with no activity', async () => {
    withTimeout(TIMEOUT_SECONDS);
    const expired = await mount();
    await wait(29 * MINUTE + 50 * 1000);
    expect(expired).not.toHaveBeenCalled();
    await wait(20 * 1000);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('computes the deadline from the clock after the tab slept', async () => {
    withTimeout(TIMEOUT_SECONDS);
    const expired = await mount();
    // A sleeping tab runs no timers; only the clock moves.
    vi.setSystemTime(Date.now() + 31 * MINUTE);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('stops its timers once unmounted', async () => {
    withTimeout(TIMEOUT_SECONDS);
    const client = new QueryClient();
    const expired = vi.fn();
    const { unmount } = render(
      <QueryClientProvider client={client}>
        <IdleSessionGuard onExpired={expired} />
      </QueryClientProvider>,
    );
    await wait(50);
    unmount();
    await wait(6 * MINUTE);
    touch();
    await wait(40 * MINUTE);
    expect(keepalives).toEqual([]);
    expect(expired).not.toHaveBeenCalled();
  });
});
