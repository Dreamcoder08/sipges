import { z } from 'zod';

/** Sections of Configuración, deep-linked as `?seccion=` (docs/adr/0006). */
export const SettingsSection = z.enum([
  'cuenta',
  'apariencia',
  'proyecto',
  'privacidad',
  'notificaciones',
]);
export type SettingsSection = z.infer<typeof SettingsSection>;

/** Search of Configuración: an unknown or missing section opens Apariencia. */
export const settingsSearch = z.object({ seccion: SettingsSection.optional().catch(undefined) });

/** Where Configuración lives; the old `/version-4` address redirects here (functional-10 T6). */
export const SETTINGS_PATH = '/configuracion';
export const settingsHref = (section: SettingsSection) => `${SETTINGS_PATH}?seccion=${section}`;

export const SECTION_LABELS: Readonly<Record<SettingsSection, string>> = {
  cuenta: 'Cuenta',
  apariencia: 'Apariencia',
  proyecto: 'Proyecto',
  privacidad: 'Privacidad y datos',
  notificaciones: 'Notificaciones',
};

/**
 * The page heading for a Configuración search: the section shown, Apariencia when the search
 * names none or an unknown one. Apariencia is a device setting, so the heading never says
 * «del proyecto» for it.
 */
export const settingsTitle = (search: string) => {
  const parsed = settingsSearch.safeParse(
    Object.fromEntries(new URLSearchParams(search).entries()),
  );
  const section = (parsed.success ? parsed.data.seccion : undefined) ?? 'apariencia';
  return `Configuración · ${SECTION_LABELS[section]}`;
};
