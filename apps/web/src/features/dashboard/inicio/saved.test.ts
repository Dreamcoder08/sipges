import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AnalystAnswer } from './ask.ts';
import {
  MAX_SAVED,
  SAVED_DAYS,
  type SavedConversation,
  deleteSaved,
  forgetAllSaved,
  loadSaved,
  saveConversation,
} from './saved.ts';

/* odd/tasks/chat-first-ui.md T11 (decision L20): conversations kept in the person's browser. */

const answer = (text: string): AnalystAnswer => ({ answer: text, sources: [], blocks: [] });
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 21, 15);
const conversation = (
  id: string,
  updatedAt: number,
  question = '¿Qué pasa?',
): SavedConversation => ({
  id,
  updatedAt,
  turns: [{ question, answer: answer(`Respuesta ${id}.`) }],
});

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

it('keeps each conversation for its person and project only', () => {
  saveConversation('ana', 'ACME/NORTE', conversation('c1', NOW), NOW);
  saveConversation('ana', 'ACME/SUR', conversation('c2', NOW), NOW);
  saveConversation('luis', 'ACME/NORTE', conversation('c3', NOW), NOW);
  expect(loadSaved('ana', 'ACME/NORTE', NOW).map((c) => c.id)).toEqual(['c1']);
  expect(loadSaved('ana', 'ACME/SUR', NOW).map((c) => c.id)).toEqual(['c2']);
  expect(loadSaved('luis', 'ACME/NORTE', NOW).map((c) => c.id)).toEqual(['c3']);
});

it('saves a conversation again in place, newest first', () => {
  saveConversation('ana', 'P', conversation('c1', NOW - 2 * DAY), NOW);
  saveConversation('ana', 'P', conversation('c2', NOW - DAY), NOW);
  saveConversation('ana', 'P', conversation('c1', NOW, '¿Y ahora?'), NOW);
  const saved = loadSaved('ana', 'P', NOW);
  expect(saved.map((c) => c.id)).toEqual(['c1', 'c2']);
  expect(saved[0]?.turns[0]?.question).toBe('¿Y ahora?');
});

it(`keeps at most ${MAX_SAVED} conversations, each ${SAVED_DAYS} days after its last answer`, () => {
  expect([MAX_SAVED, SAVED_DAYS]).toEqual([20, 30]);
  for (let i = 0; i < MAX_SAVED + 3; i++)
    saveConversation('ana', 'P', conversation(`c${i}`, NOW - i * 1000), NOW);
  expect(loadSaved('ana', 'P', NOW)).toHaveLength(MAX_SAVED);
  expect(loadSaved('ana', 'P', NOW)[0]?.id).toBe('c0');
  localStorage.clear();
  saveConversation('ana', 'P', conversation('old', NOW - (SAVED_DAYS + 1) * DAY), NOW);
  saveConversation('ana', 'P', conversation('fresh', NOW - (SAVED_DAYS - 1) * DAY), NOW);
  expect(loadSaved('ana', 'P', NOW).map((c) => c.id)).toEqual(['fresh']);
});

it('deletes one conversation, and forgets every saved conversation at sign-out', () => {
  saveConversation('ana', 'P', conversation('c1', NOW), NOW);
  saveConversation('ana', 'P', conversation('c2', NOW - 1), NOW);
  deleteSaved('ana', 'P', 'c1');
  expect(loadSaved('ana', 'P', NOW).map((c) => c.id)).toEqual(['c2']);
  localStorage.setItem('sipges.sidebar', 'hidden');
  saveConversation('luis', 'Q', conversation('c3', NOW), NOW);
  forgetAllSaved();
  expect(loadSaved('ana', 'P', NOW)).toEqual([]);
  expect(loadSaved('luis', 'Q', NOW)).toEqual([]);
  expect(localStorage.getItem('sipges.sidebar')).toBe('hidden');
});

it('reads a damaged or foreign entry as nothing saved, and survives a storage that refuses', () => {
  localStorage.setItem('sipges.conversations.v1:ana:P', '{not json');
  expect(loadSaved('ana', 'P', NOW)).toEqual([]);
  localStorage.setItem('sipges.conversations.v1:ana:P', JSON.stringify([{ id: 1, turns: 'x' }]));
  expect(loadSaved('ana', 'P', NOW)).toEqual([]);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('full', 'QuotaExceededError');
  });
  expect(() => saveConversation('ana', 'P', conversation('c1', NOW), NOW)).not.toThrow();
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('blocked', 'SecurityError');
  });
  expect(loadSaved('ana', 'P', NOW)).toEqual([]);
});
