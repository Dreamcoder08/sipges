import { z } from 'zod';
import { forgetSavedConversations, savedKeyOf } from '../../../shared/lib/saved-conversations.ts';
import { AnalystAnswer } from './ask.ts';

/**
 * Saved conversations (odd/tasks/chat-first-ui.md T11, decision L20): kept in this browser, under
 * the person and the project, never on the server. At most MAX_SAVED, each SAVED_DAYS after its
 * last answer; signing out forgets them all. Storage that refuses (full, blocked, private mode)
 * just means nothing is saved: the conversation itself goes on.
 */

export const MAX_SAVED = 20;
export const SAVED_DAYS = 30;
const DAY_MS = 86_400_000;

const SavedTurn = z.object({ question: z.string().min(1), answer: AnalystAnswer });
const SavedConversation = z.object({
  id: z.string().min(1),
  updatedAt: z.number().finite(),
  turns: z.array(SavedTurn).min(1),
});
export type SavedTurn = z.infer<typeof SavedTurn>;
export type SavedConversation = z.infer<typeof SavedConversation>;

const keyOf = (person: string, scope: string) => savedKeyOf(person, scope);

const read = (key: string): SavedConversation[] => {
  try {
    const raw = localStorage.getItem(key);
    const parsed = z.array(SavedConversation).safeParse(raw ? JSON.parse(raw) : []);
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
};

/** The event every write sends, so a screen reading the saved list sees it change. */
const CHANGED = 'sipges-saved-conversations';

const write = (key: string, list: readonly SavedConversation[]) => {
  try {
    if (list.length) localStorage.setItem(key, JSON.stringify(list));
    else localStorage.removeItem(key);
  } catch {
    // Full or blocked: nothing is saved this time.
  }
  window.dispatchEvent(new Event(CHANGED));
};

/** For useSyncExternalStore: told of every write here, and of other tabs' writes. */
export const subscribeSaved = (onChange: () => void) => {
  window.addEventListener(CHANGED, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener('storage', onChange);
  };
};

/** The stored text of the person's conversations in the project: a stable snapshot. */
export const savedSnapshot = (person: string, scope: string): string => {
  try {
    return localStorage.getItem(keyOf(person, scope)) ?? '';
  } catch {
    return '';
  }
};

/** A snapshot's conversations, newest first; a damaged one reads as none. */
export const parseSaved = (snapshot: string): SavedConversation[] => {
  try {
    const parsed = z.array(SavedConversation).safeParse(snapshot ? JSON.parse(snapshot) : []);
    return parsed.success
      ? parsed.data.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SAVED)
      : [];
  } catch {
    return [];
  }
};

/** Drops the expired conversations of the person in the project. */
export const purgeExpired = (person: string, scope: string, now: number) => {
  const key = keyOf(person, scope);
  const all = read(key);
  const kept = loadSaved(person, scope, now);
  if (kept.length !== all.length) write(key, kept);
};

/** The person's saved conversations of the project, newest first, without the expired ones. */
export const loadSaved = (person: string, scope: string, now: number): SavedConversation[] =>
  read(keyOf(person, scope))
    .filter((c) => now - c.updatedAt <= SAVED_DAYS * DAY_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_SAVED);

/** Saves a conversation, replacing an earlier save of it; the list stays within its limits. */
export const saveConversation = (
  person: string,
  scope: string,
  conversation: SavedConversation,
  now: number,
) => {
  const key = keyOf(person, scope);
  const others = loadSaved(person, scope, now).filter((c) => c.id !== conversation.id);
  write(
    key,
    [conversation, ...others].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SAVED),
  );
};

/** Deletes one saved conversation of the person in the project. */
export const deleteSaved = (person: string, scope: string, id: string) => {
  const key = keyOf(person, scope);
  write(
    key,
    read(key).filter((c) => c.id !== id),
  );
};

/** Deletes every saved conversation of the person in the project, readable or not. */
export const deleteAllSaved = (person: string, scope: string) => write(keyOf(person, scope), []);

/** Forgets every saved conversation of this browser, of every person and project (sign-out). */
export const forgetAllSaved = forgetSavedConversations;
