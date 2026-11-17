/**
 * Whether the wide sidebar is hidden (chat-first-ui T12). A per-device convenience like the
 * theme (docs/adr/0018): kept in localStorage, never sent to the server. Phones and tablets
 * ignore it, since their sidebar is a drawer that opens on demand.
 */
const KEY = 'sipges.sidebar';

export const readSidebarHidden = (): boolean => {
  try {
    return window.localStorage.getItem(KEY) === 'hidden';
  } catch {
    return false;
  }
};

export const storeSidebarHidden = (hidden: boolean) => {
  try {
    window.localStorage.setItem(KEY, hidden ? 'hidden' : 'shown');
  } catch {
    // Private mode or blocked storage: the choice still applies to this page.
  }
};
