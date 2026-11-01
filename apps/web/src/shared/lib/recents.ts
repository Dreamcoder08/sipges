import { useSyncExternalStore } from 'react';

/**
 * «Recientes» of the sidebar: the last screens and hub tabs opened in this browser tab. It lives
 * in sessionStorage, so it ends with the tab and nothing persists on the device (the project
 * selection is server-owned and localStorage stays empty), and it never reaches the server; it
 * holds screen names and in-app links only, no record data.
 */
export type Recent = { href: string; label: string };

const KEY = 'sipges.recents';
const LIMIT = 4;
const listeners = new Set<() => void>();

const isRecent = (value: unknown): value is Recent =>
  typeof value === 'object' &&
  value !== null &&
  'href' in value &&
  'label' in value &&
  typeof value.href === 'string' &&
  value.href.startsWith('/') &&
  typeof value.label === 'string';

const parse = (raw: string | null): readonly Recent[] => {
  try {
    const list: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(list) ? list.filter(isRecent).slice(0, LIMIT) : [];
  } catch {
    return [];
  }
};

// useSyncExternalStore needs the same array until the stored text changes.
let snapshot: { raw: string | null; list: readonly Recent[] } = { raw: null, list: [] };

export const readRecents = (): readonly Recent[] => {
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(KEY);
  } catch {
    // Blocked storage: no recents in this tab.
  }
  if (raw !== snapshot.raw) snapshot = { raw, list: parse(raw) };
  return snapshot.list;
};

export const recordVisit = (visit: Recent) => {
  const current = readRecents();
  if (current[0]?.href === visit.href && current[0].label === visit.label) return;
  const next = [visit, ...current.filter((item) => item.href !== visit.href)].slice(0, LIMIT);
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    return;
  }
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useRecents = () => useSyncExternalStore(subscribe, readRecents, readRecents);
