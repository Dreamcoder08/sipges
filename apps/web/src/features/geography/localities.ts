import { foldText } from '../../shared/lib/text.ts';
import type { LonLat } from './sechura-base.ts';

/**
 * Approximate centres of the populated places of the Sechura province, used to place records
 * whose `Territorio` names one of them. Positions are for orientation, not survey points.
 */
export const LOCALITIES: readonly { name: string; at: LonLat }[] = [
  { name: 'Sechura', at: [-80.8222, -5.5569] },
  { name: 'Parachique', at: [-80.8653, -5.7425] },
  { name: 'Bayóvar', at: [-81.05, -5.795] },
  { name: 'Vice', at: [-80.7767, -5.4183] },
  { name: 'Bernal', at: [-80.7428, -5.4597] },
  { name: 'Bellavista de la Unión', at: [-80.7536, -5.4378] },
  { name: 'Rinconada Llicuar', at: [-80.77, -5.4697] },
  { name: 'Cristo Nos Valga', at: [-80.7389, -5.4936] },
];

/**
 * Locality named in a free-text territory. The first place mentioned wins ("Vice, Sechura" is
 * Vice); a longer name wins at the same position ("Bellavista de la Unión").
 */
export const localityOf = (territory: unknown) => {
  const text = foldText(territory);
  if (!text) return null;
  let best: { place: (typeof LOCALITIES)[number]; at: number } | null = null;
  for (const place of LOCALITIES) {
    const at = text.indexOf(foldText(place.name));
    if (at < 0) continue;
    if (!best || at < best.at || (at === best.at && place.name.length > best.place.name.length))
      best = { place, at };
  }
  return best?.place ?? null;
};
