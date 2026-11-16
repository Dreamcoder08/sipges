import type { DesktopUpdateStarted, DesktopUpdateStatus, ErrorResponse } from '@sipges/contracts';
import { Hono, type MiddlewareHandler } from 'hono';
import type { AppEnv } from '../../../platform/http/env.ts';
import type { DesktopUpdateService } from '../application/index.ts';

export const DESKTOP_UPDATE_PATH = '/system/desktop/update';

/**
 * Administrators only. The shared access policy lives in identity; this context gates its own
 * routes because they exist only on a managed desktop install (the cloud never mounts them).
 */
const adminOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('identity').role !== 'admin')
    return c.json({ detail: 'Requiere rol administrador' } satisfies ErrorResponse, 403);
  return next();
};

/**
 * Update notice of a managed desktop install (odd/tasks/desktop-updates.md T3). Nothing is
 * downloaded or installed until POST, which only asks the launcher for the release it verified.
 */
export const desktopUpdateRoutes = (updates: DesktopUpdateService) =>
  new Hono<AppEnv>()
    .use(DESKTOP_UPDATE_PATH, adminOnly)
    .use(`${DESKTOP_UPDATE_PATH}/*`, adminOnly)
    .get(DESKTOP_UPDATE_PATH, async (c) =>
      c.json((await updates.status()) satisfies DesktopUpdateStatus, 200, {
        'Cache-Control': 'no-store',
      }),
    )
    .post(DESKTOP_UPDATE_PATH, async (c) => {
      const version = await updates.start();
      if (version === null)
        return c.json(
          { detail: 'No hay una actualización disponible' } satisfies ErrorResponse,
          409,
        );
      return c.json({ status: 'restarting', version } satisfies DesktopUpdateStarted, 202);
    })
    .post(`${DESKTOP_UPDATE_PATH}/dismiss`, (c) => {
      updates.dismiss();
      return c.body(null, 204);
    });
