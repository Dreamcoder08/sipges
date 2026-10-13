const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
};

/** Escapes text for HTML element content and quoted attributes (Python html.escape(quote=True)). */
export const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => ENTITIES[char] ?? char);
