import type { ProjectSettings } from '@mascli/contracts';
import { createContext, type ReactNode, useContext } from 'react';
import type { Level } from './text.ts';

/** Null while unknown or outside a project: every screen behaves as MASCLI 3.0. */
const SettingsContext = createContext<ProjectSettings | null>(null);

export const ProjectSettingsProvider = ({
  value,
  children,
}: {
  value: ProjectSettings | null;
  children: ReactNode;
}) => <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;

export const useProjectSettings = () => useContext(SettingsContext);

export const useVersion4 = () => useProjectSettings()?.version4 === true;

/** "Naranja – Requiere intervención preventiva" with MASCLI 4.0 on; the 3.0 name otherwise. */
export const levelWithMeaning = (
  settings: ProjectSettings | null,
  level: Level,
  fallback: string,
) => (settings?.version4 ? `${level} – ${settings.level_meanings[level]}` : fallback);

export const useLevelLabel = () => {
  const settings = useProjectSettings();
  return (level: Level, fallback: string) => levelWithMeaning(settings, level, fallback);
};
