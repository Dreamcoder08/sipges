/**
 * Update notice of a managed desktop install (odd/tasks/desktop-updates.md T3). The desktop
 * launcher verifies the local release (signature with the installed key, newer version) and
 * owns the update; the API only reports what it verified and passes on an explicit request.
 */

/** What the launcher verified at startup; `available` is null when nothing newer is signed. */
export type DesktopUpdateCheck = {
  readonly installed: string | null;
  readonly available: { readonly version: string; readonly notes: string | null } | null;
};

/** The folder shared with the launcher. A missing or invalid status reads as "nothing found". */
export type DesktopUpdateChannel = {
  read(): Promise<DesktopUpdateCheck>;
  /** Asks the launcher to stop SIPGES, install `version` and start it again. */
  request(version: string): Promise<void>;
};

export type DesktopUpdateStatusView = {
  installed: string | null;
  available: string | null;
  notes: string | null;
  dismissed: boolean;
};

export type DesktopUpdateService = {
  status(): Promise<DesktopUpdateStatusView>;
  /** «Ahora no»: kept in memory, so the notice returns on the next start. */
  dismiss(): void;
  /** Returns the requested version, or null when no verified update is available. */
  start(): Promise<string | null>;
};

export const createDesktopUpdateService = (channel: DesktopUpdateChannel): DesktopUpdateService => {
  let dismissed = false;
  return {
    async status() {
      const check = await channel.read();
      return {
        installed: check.installed,
        available: check.available?.version ?? null,
        notes: check.available?.notes ?? null,
        dismissed,
      };
    },
    dismiss() {
      dismissed = true;
    },
    async start() {
      const { available } = await channel.read();
      if (!available) return null;
      await channel.request(available.version);
      return available.version;
    },
  };
};
