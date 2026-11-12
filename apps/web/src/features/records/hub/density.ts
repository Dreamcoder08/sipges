import { useState } from 'react';

export type Density = 'cozy' | 'compact';

/** Per tab and per browser tab: sessionStorage, so nothing persists on the device (e2e 03-tenancy). */
const keyFor = (tab: string) => `sipges.registros.density.${tab}`;

const read = (tab: string, fallback: Density): Density => {
  try {
    const stored = sessionStorage.getItem(keyFor(tab));
    return stored === 'compact' || stored === 'cozy' ? stored : fallback;
  } catch {
    return fallback;
  }
};

/** `fallback` until the person chooses: the desktop table of Todos starts compact. */
export const useDensity = (tab: string, fallback: Density = 'cozy') => {
  const [density, setDensity] = useState<Density>(() => read(tab, fallback));
  const choose = (next: Density) => {
    setDensity(next);
    try {
      sessionStorage.setItem(keyFor(tab), next);
    } catch {
      // Storage can be blocked; the choice then lasts until the tab is left.
    }
  };
  return [density, choose] as const;
};
