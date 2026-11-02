import { z } from 'zod';

/** Sections of Configuración, deep-linked as `?seccion=` (docs/adr/0006). */
export const SettingsSection = z.enum(['apariencia', 'proyecto', 'privacidad', 'notificaciones']);
export type SettingsSection = z.infer<typeof SettingsSection>;

/** Search of `/version-4`: an unknown or missing section opens Apariencia. */
export const settingsSearch = z.object({ seccion: SettingsSection.optional().catch(undefined) });

export const SETTINGS_PATH = '/version-4';
export const settingsHref = (section: SettingsSection) => `${SETTINGS_PATH}?seccion=${section}`;
