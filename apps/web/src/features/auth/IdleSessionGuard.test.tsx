import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_HEADER, SESSION_REMAINING_HEADER, request } from '../../shared/api/client.ts';
import { resetApi, server } from '../../test/server.ts';
import { IdleSessionGuard } from './IdleSessionGuard.tsx';

const MINUTE = 60_000;
const TIMEOUT_SECONDS = 30 * 60;

/**
 * A synthetic Go session with the server's rule: user requests move the expiry to a full timeout
 * once less than the timeout minus five minutes remains, background ones never do, and every
 * answer tells the remaining seconds in SESSION_REMAINING_HEADER.
 */
let expiresAt = 0;
const remainingNow = () => Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
const sessionAnswer = ({ request: req }: { request: Request }) => {
  const now = Date.now();
  if (now >= expiresAt) return HttpResponse.json({ detail: 'Inicie sesión' }, { status: 401 });
  if (
    req.headers.get(BACKGROUND_HEADER) !== '1' &&
    expiresAt - now < (TIMEOUT_SECONDS - 300) * 1000
  ) {
    expiresAt = now + TIMEOUT_SECONDS * 1000;
  }
  return HttpResponse.json(
    { sessions: [] },
    { headers: { [SESSION_REMAINING_HEADER]: String(remainingNow()) } },
  );
};
/**
 * An answer that tells a fixed remainder, as another tab's activity would have left it: the
 * synthetic server's own expiry moves with it, so a later check by this tab hears the same.
 */
const tells = (seconds: number) => () => {
  expiresAt = Date.now() + seconds * 1000;
  return HttpResponse.json(
    { ok: true },
    { headers: { [SESSION_REMAINING_HEADER]: String(seconds) } },
  );
};

/**
 * GET /system/auth/sessions sent: keepalives (no background header, recorded as such) and the
 * background checks a tab makes before warning or ending, counted apart.
 */
const keepalives: (string | null)[] = [];
let checks = 0;
const record = ({ request }: { request: Request }) => {
  if (new URL(request.url).pathname !== '/system/auth/sessions') return;
  const background = request.headers.get(BACKGROUND_HEADER);
  if (background === '1') checks += 1;
  else keepalives.push(background);
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
  checks = 0;
  server.events.on('request:start', record);
  expiresAt = Date.now() + TIMEOUT_SECONDS * 1000;
  server.use(
    http.get('/system/auth/sessions', sessionAnswer),
    http.get('/user-probe', sessionAnswer),
  );
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

/** Mounts the guard; `firstRequest` is the app's first data request, which tells the deadline. */
const mount = async (onExpired = vi.fn(), firstRequest = true) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <IdleSessionGuard onExpired={onExpired} />
    </QueryClientProvider>,
  );
  // Let the providers answer arrive before the clock moves.
  await act(() => vi.advanceTimersByTimeAsync(50));
  if (firstRequest) await act(() => request('/user-probe'));
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

  it('takes the deadline only from the remaining time the server tells', async () => {
    // The verifier's case: one request at 4:59 whose session the server did not extend.
    withTimeout(60 * 60);
    server.use(http.get('/told', tells(3300)));
    const expired = await mount(vi.fn(), false);
    await wait(4 * MINUTE + 59 * 1000);
    await act(() => request('/told'));
    await wait(53 * MINUTE - 1000);
    expect(screen.queryByRole('dialog')).toBeNull();
    await wait(2000);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await wait(2 * MINUTE - 2000);
    expect(expired).not.toHaveBeenCalled();
    await wait(2000);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('follows a background answer that tells more time, as when another tab is active', async () => {
    withTimeout(TIMEOUT_SECONDS);
    server.use(http.get('/poll', tells(TIMEOUT_SECONDS)));
    await mount();
    await wait(20 * MINUTE);
    await act(() => request('/poll', { background: true }));
    await wait(8 * MINUTE + 10 * 1000);
    expect(screen.queryByRole('dialog')).toBeNull();
    await wait(20 * MINUTE);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // A later answer with more time closes the warning again.
    await act(() => request('/poll', { background: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not move the deadline on answers without the remaining time', async () => {
    withTimeout(TIMEOUT_SECONDS);
    server.use(
      http.get('/silent', () => HttpResponse.json({ ok: true })),
      http.get('/gone', () => HttpResponse.json({ detail: 'x' }, { status: 401 })),
    );
    await mount();
    await wait(10 * MINUTE);
    await act(() => request('/system/auth/me'));
    await act(() => request('/silent'));
    await act(() => request('/gone').catch(() => undefined));
    await wait(18 * MINUTE + 10 * 1000);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('waits without a warning until the server first tells the remaining time', async () => {
    withTimeout(TIMEOUT_SECONDS);
    const expired = await mount(vi.fn(), false);
    await wait(70 * MINUTE);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(expired).not.toHaveBeenCalled();
    // The first answer that tells the remaining time starts the timer.
    server.use(http.get('/told', tells(5 * 60)));
    await act(() => request('/told'));
    expect(screen.queryByRole('dialog')).toBeNull();
    await wait(3 * MINUTE + 10 * 1000);
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

  it('asks the server before warning or ending, as a hidden tab while another one is active', async () => {
    withTimeout(TIMEOUT_SECONDS);
    const expired = await mount();
    // Another tab keeps working: the server's deadline moves and this tab hears nothing of it.
    await wait(20 * MINUTE);
    expiresAt = Date.now() + TIMEOUT_SECONDS * 1000;
    await wait(8 * MINUTE + 10 * 1000);
    expect(screen.queryByRole('dialog')).toBeNull();
    await wait(2 * MINUTE + 20 * 1000);
    expect(expired).not.toHaveBeenCalled();
    expect(checks).toBeGreaterThan(0);
    expect(keepalives).toEqual([]);
    // Once the server's deadline itself passes, the tab ends.
    await wait(TIMEOUT_SECONDS * 1000);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('asks again at the deadline when another tab extended the session during the warning', async () => {
    withTimeout(TIMEOUT_SECONDS);
    const expired = await mount();
    await wait(28 * MINUTE + 10 * 1000);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // Another tab works during this tab's warning.
    expiresAt = Date.now() + TIMEOUT_SECONDS * 1000;
    await wait(2 * MINUTE);
    expect(expired).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('decides alone when the server does not answer its check', async () => {
    withTimeout(TIMEOUT_SECONDS);
    server.use(
      http.get('/system/auth/sessions', ({ request: req }) =>
        req.headers.get(BACKGROUND_HEADER) === '1'
          ? new Promise<never>(() => undefined)
          : sessionAnswer({ request: req }),
      ),
    );
    const expired = await mount();
    await wait(28 * MINUTE + 30 * 1000);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await wait(2 * MINUTE);
    expect(expired).toHaveBeenCalledTimes(1);
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
    // It asks the server first, which answers 401 for the session that ran out.
    await wait(50);
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
