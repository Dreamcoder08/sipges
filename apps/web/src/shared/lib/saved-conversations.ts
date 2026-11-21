/**
 * Where Inicio keeps saved conversations in this browser (odd/tasks/chat-first-ui.md T11, L20), and
 * how every sign-out forgets them, so a shared computer keeps none. Shared, because signing out
 * happens in auth, the shell and settings, which may not import the dashboard feature.
 */
export const SAVED_CONVERSATIONS_PREFIX = 'sipges.conversations.v1:';

/** Forgets every saved conversation of this browser, of every person and project. */
export const forgetSavedConversations = () => {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(SAVED_CONVERSATIONS_PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // Blocked storage holds nothing to forget.
  }
};
