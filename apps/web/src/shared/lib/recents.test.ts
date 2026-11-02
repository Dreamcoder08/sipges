import { afterEach, expect, it } from 'vitest';
import { readRecents, recordVisit } from './recents.ts';

afterEach(() => window.sessionStorage.clear());

// Regression (functional-closure S13): «Recientes» of one project never lists another's screens.
it('keeps the recents of each project apart', () => {
  recordVisit('SIPGES/PRJ-SECHURA', { href: '/mapa', label: 'Mapa territorial' });
  recordVisit('ACME/NORTE', { href: '/alertas', label: 'Alertas' });

  expect(readRecents('SIPGES/PRJ-SECHURA')).toEqual([{ href: '/mapa', label: 'Mapa territorial' }]);
  expect(readRecents('ACME/NORTE')).toEqual([{ href: '/alertas', label: 'Alertas' }]);
  expect(JSON.parse(window.sessionStorage.getItem('sipges.recents:ACME/NORTE') ?? '[]')).toEqual([
    { href: '/alertas', label: 'Alertas' },
  ]);
  expect(window.sessionStorage.getItem('sipges.recents')).toBeNull();
});
