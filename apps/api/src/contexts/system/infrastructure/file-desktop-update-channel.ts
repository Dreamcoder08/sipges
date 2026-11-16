import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { DesktopUpdateChannel, DesktopUpdateCheck } from '../application/index.ts';

/** Written by deploy/desktop/updater/launcher.mjs before and after its startup check. */
const STATUS = 'status.json';
/** Written here after the click; the launcher reads it, removes it and runs the update. */
const REQUEST = 'request.json';

const Version = z.string().min(1).max(256);
const LauncherStatus = z.object({
  format: z.literal(1),
  installed: Version.nullable(),
  available: z.object({ version: Version, notes: z.string().max(4000).nullable() }).nullable(),
});

const NOTHING: DesktopUpdateCheck = { installed: null, available: null };

/** File channel in the folder named by SIPGES_DESKTOP_UPDATE_DIR (absolute, owned by the launcher). */
export const createFileDesktopUpdateChannel = (dir: string): DesktopUpdateChannel => ({
  async read() {
    let text: string;
    try {
      text = await readFile(join(dir, STATUS), 'utf8');
    } catch {
      return NOTHING;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return NOTHING;
    }
    const parsed = LauncherStatus.safeParse(value);
    return parsed.success
      ? { installed: parsed.data.installed, available: parsed.data.available }
      : NOTHING;
  },
  async request(version) {
    // Written whole, then renamed: the launcher never reads half a request.
    const temporary = join(dir, `.${REQUEST}.${randomUUID()}.tmp`);
    const body = { format: 1, version, requestedAt: new Date().toISOString() };
    await writeFile(temporary, `${JSON.stringify(body)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(dir, REQUEST));
  },
});
