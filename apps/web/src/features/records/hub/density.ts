import { useState } from 'react';

export type Density = 'cozy' | 'compact';

/** Per tab and per browser tab: sessionStorage, so nothing persists on the device (e2e 03-tenancy). */
const keyFor = (tab: string) => `sipges.registros.density.${tab}`;

const read = (tab: string): Density => {
  try {
    return sessionStorage.getItem(keyFor(tab)) === 'compact' ? 'compact' : 'cozy';
  } catch {
    return 'cozy';
  }
};

export const useDensity = (tab: string) => {
  const [density, setDensity] = useState<Density>(() => read(tab));
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
