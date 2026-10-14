import { ICON_PATHS, type IconName } from './icons.ts';

/**
 * Line icons drawn on a 24-unit grid with the current text colour (docs/adr/0015). They are
 * decorative: the control that holds one always carries its own accessible name.
 */
export const Icon = ({ name, className }: { name: IconName; className?: string | undefined }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    width="1em"
    height="1em"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d={ICON_PATHS[name]} />
  </svg>
);
