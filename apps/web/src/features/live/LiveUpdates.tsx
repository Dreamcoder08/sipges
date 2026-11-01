import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

/** Changes arriving together refresh the screen once. */
export const REFRESH_DEBOUNCE_MS = 800;
const MAX_BACKOFF_MS = 60_000;

type Frame = { event: string; id: string };

/** Splits a server-sent events buffer into complete frames and the unfinished rest. */
export const parseFrames = (buffer: string): { frames: Frame[]; rest: string } => {
  const parts = buffer.replace(/\r\n/g, '\n').split('\n\n');
  const rest = parts.pop() ?? '';
  const frames = parts.flatMap((part) => {
    const field = (name: string) =>
      part
        .split('\n')
        .find((line) => line.startsWith(`${name}:`))
        ?.slice(name.length + 1)
        .trim();
    const event = field('event');
    return event ? [{ event, id: field('id') ?? '' }] : [];
  });
  return { frames, rest };
};

/**
 * Listens to the project's activity stream (docs/adr/0014 §10) and refreshes every query of
 * the project when something changes, so open screens stay current without reloading. It
 * uses fetch rather than EventSource to send the project header, and reconnects with backoff.
 */
export const LiveUpdates = ({ scope }: { scope: string }) => {
  const client = useQueryClient();
  useEffect(() => {
    const abort = new AbortController();
    let lastId = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => void client.invalidateQueries({ predicate: (q) => q.queryKey.includes(scope) }),
        REFRESH_DEBOUNCE_MS,
      );
    };
    const listen = async () => {
      const headers = new Headers({ accept: 'text/event-stream', 'X-SIPGES-Scope': scope });
      if (lastId) headers.set('Last-Event-ID', lastId);
      const response = await fetch('/system/events', {
        credentials: 'same-origin',
        headers,
        signal: abort.signal,
      });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        const parsed = parseFrames(buffer + decoder.decode(value, { stream: true }));
        buffer = parsed.rest;
        for (const frame of parsed.frames) {
          if (frame.id) lastId = frame.id;
          if (frame.event === 'activity') refresh();
        }
      }
    };
    void (async () => {
      let backoff = 1_000;
      while (!abort.signal.aborted) {
        try {
          await listen();
          backoff = 1_000;
        } catch {
          if (abort.signal.aborted) return;
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        }
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    })();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [client, scope]);
  return null;
};
