import { z } from 'zod';

/**
 * GET /system/desktop/update — managed desktop installs only (odd/tasks/desktop-updates.md T3).
 * `available` is a newer release the desktop launcher already verified with the installed
 * update key; `dismissed` is true after «Ahora no» until the next start.
 */
export const DesktopUpdateStatus = z.object({
  installed: z.string().nullable(),
  available: z.string().nullable(),
  notes: z.string().nullable(),
  dismissed: z.boolean(),
});
export type DesktopUpdateStatus = z.infer<typeof DesktopUpdateStatus>;

/** POST /system/desktop/update — 202: the launcher stops SIPGES, updates and restarts it. */
export const DesktopUpdateStarted = z.object({
  status: z.literal('restarting'),
  version: z.string(),
});
export type DesktopUpdateStarted = z.infer<typeof DesktopUpdateStarted>;
