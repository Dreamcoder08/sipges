import type { ProjectSettings } from '@mascli/contracts';
import { createContext, type ReactNode, useContext } from 'react';
import type { Level } from './text.ts';

/** Null while unknown or outside a project: colour labels fall back to their plain names. */
const SettingsContext = createContext<ProjectSettings | null>(null);

export const ProjectSettingsProvider = ({
  value,
  children,
}: {
  value: ProjectSettings | null;
  children: ReactNode;
}) => <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;

export const useProjectSettings = () => useContext(SettingsContext);

/** "Naranja – Requiere intervención preventiva"; the plain name while the settings are unknown. */
export const levelWithMeaning = (
  settings: ProjectSettings | null,
  level: Level,
  fallback: string,
) => (settings ? `${level} – ${settings.level_meanings[level]}` : fallback);

export const useLevelLabel = () => {
  const settings = useProjectSettings();
  return (level: Level, fallback: string) => levelWithMeaning(settings, level, fallback);
};
