/** Neutral display label for the original demo administrator; identity stays unchanged. */
export const accountDisplayName = (name: string): string =>
  name === 'Administración de demo sintética' ? 'Administración SIPGES' : name;

/** Up to two capital letters for an avatar, from the display name. */
export const accountInitials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
