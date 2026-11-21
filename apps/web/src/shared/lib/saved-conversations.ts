/**
 * Where Inicio keeps saved conversations in this browser (odd/tasks/chat-first-ui.md T11, L20), and
 * how every sign-out forgets them, so a shared computer keeps none. Shared, because signing out
 * happens in auth, the shell and settings, which may not import the dashboard feature.
 */
export const SAVED_CONVERSATIONS_PREFIX = 'sipges.conversations.v1:';

/** The start of a person's keys; each part is encoded, so no person or project can collide. */
export const savedKeyOf = (person: string, scope?: string) =>
  `${SAVED_CONVERSATIONS_PREFIX}${encodeURIComponent(person)}:${scope === undefined ? '' : encodeURIComponent(scope)}`;

// Bumped by every sign-out: an answer asked before it is not saved when it arrives after it.
let generation = 0;

/** The sign-out generation an answer was asked in. */
export const signOutGeneration = () => generation;

const forgetWhere = (drop: (key: string) => boolean) => {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(SAVED_CONVERSATIONS_PREFIX) && drop(key)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // Blocked storage holds nothing to forget.
  }
};

/**
 * Forgets the saved conversations of everyone but person: someone signing in on a browser where
 * another person's session simply expired (no sign-out) sees none of theirs.
 */
export const forgetOtherPeople = (person: string) =>
  forgetWhere((key) => !key.startsWith(savedKeyOf(person)));

/** Forgets every saved conversation of this browser, of every person and project. */
export const forgetSavedConversations = () => {
  generation++;
  forgetWhere(() => true);
};
