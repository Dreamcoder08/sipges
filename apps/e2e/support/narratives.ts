import { DEFAULT_SCOPE, expect } from './fixtures.ts';
import type { Page } from '@playwright/test';

/**
 * Synthetic narratives whose dates come only in non-ISO shapes (Spanish month name, D.M.YYYY,
 * an Excel serial day and D-M-YYYY), in 2030 so they are the latest and anchor the trend window.
 */
export const seedNonIsoNarratives = async (page: Page, stamp: number) => {
  const rows = [
    { Fecha_Inicio: '2 de enero de 2030', Tema: `Calidad del agua ${stamp}` },
    { Fecha_Inicio: '04.01.2030', Tema: `Demanda de empleo local ${stamp}` },
    { Fecha_Inicio: 47489, Tema: `Junta directiva comunal ${stamp}` },
    { Fecha: '08-01-2030', Tema: `Publicación viral ${stamp}` },
  ];
  for (const payload of rows) {
    const created = await page.request.post('/api/narrativas', {
      headers: { 'X-SIPGES-Scope': DEFAULT_SCOPE, Origin: new URL(page.url()).origin },
      data: { payload: { ...payload, Descripcion: `Publicación sintética ${stamp}` } },
    });
    expect(created.ok()).toBe(true);
  }
};
