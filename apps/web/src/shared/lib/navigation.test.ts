import { expect, it } from 'vitest';
import { mapHref } from './navigation.tsx';

it('opens the Territorio map focused on one record', () => {
  expect(mapHref('eventos', 'EV-1')).toBe('/territorio?vista=mapa&registro=eventos%3AEV-1');
  expect(mapHref('actores', 'A 7/b')).toBe('/territorio?vista=mapa&registro=actores%3AA%207%2Fb');
});
