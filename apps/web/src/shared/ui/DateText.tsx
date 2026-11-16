import { formatDateTime, formatDay, limaDay } from '../lib/format.ts';

/**
 * A stored day or instant as people read it (odd/tasks/functional-10.md T1): the Lima day in
 * Spanish, with the Lima time when `time` is set. `<time datetime>` keeps the stored value for
 * machines; text that is not a date (a narrative deadline) stays plain text.
 */
export const DateText = ({
  value,
  time = false,
  fallback = '—',
}: {
  value: string | null | undefined;
  time?: boolean;
  fallback?: string;
}) => {
  const stored = (value ?? '').trim();
  if (!stored) return <>{fallback}</>;
  if (!limaDay(stored)) return <>{stored}</>;
  return <time dateTime={stored}>{time ? formatDateTime(stored) : formatDay(stored)}</time>;
};
