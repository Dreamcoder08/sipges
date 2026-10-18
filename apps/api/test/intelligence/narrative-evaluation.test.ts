import { describe, expect, it, vi } from 'vitest';
import { createIntelligenceService } from '../../src/contexts/intelligence/application/index.ts';
import type { AlertStore } from '../../src/contexts/intelligence/application/index.ts';

const scope = { companyId: 'synthetic', projectId: 'SYNTHETIC' };
const payload = {
  Descripcion: 'Exigimos agua limpia: habrá paro y bloqueo este lunes. Convocatoria a asamblea.',
  URL_Publicacion: 'https://example.org/synthetic',
  Territorio: 'Territorio documentado en reporte',
};
const setup = () => {
  const create = vi.fn(async (_tenant, alert) => ({
    ...alert,
    status: 'Pendiente de verificación',
    reviewerNote: null,
    reviewedAt: null,
  }));
  const embed = vi.fn();
  const service = createIntelligenceService({
    narratives: { read: async () => [] },
    embeddings: { model: 'unused', embed },
    alerts: { create } as unknown as AlertStore,
    clock: { now: () => new Date('2026-10-17T12:00:00Z') },
    randomHex: () => 'synthetic',
  });
  return { service, create, embed };
};

describe('authorized narrative evaluation', () => {
  it('uses stored evidence and explicit territory, rules only, with original record provenance', async () => {
    const { service, create, embed } = setup();
    expect(
      await service.evaluateNarrative(scope, {
        id: 'NAR-SYNTHETIC',
        payload,
        marking: 'interno',
        minimumLevel: 'Media',
      }),
    ).toEqual({ outcome: 'created', alertId: 'DIG-SYNTHETIC' });
    expect(create.mock.calls[0]?.[1]).toMatchObject({
      territory: payload.Territorio,
      sourceUrl: payload.URL_Publicacion,
      sourceRecord: { module: 'Narrativas', id: 'NAR-SYNTHETIC' },
      semanticActive: false,
    });
    expect(embed).not.toHaveBeenCalled();
  });
  it.each(['Documento', 'Reporte de campo', 'Publicación digital'])(
    'preserves the documented source type %s',
    async (sourceType) => {
      const { service, create } = setup();
      expect(
        await service.evaluateNarrative(scope, {
          id: 'NAR-SYNTHETIC',
          payload: { ...payload, Tipo_Fuente: sourceType },
          marking: 'interno',
        }),
      ).toMatchObject({ outcome: 'created' });
      expect(create.mock.calls[0]?.[1]).toMatchObject({ sourceType });
    },
  );
  it.each([
    { marking: 'restringido', payload },
    { marking: 'unknown', payload },
    { marking: 'interno', payload: { ...payload, Tipo_Fuente: 'Fuente inventada' } },
    { marking: 'interno', payload: { ...payload, Tipo_Fuente: 42 } },
    { marking: 'interno', payload: { ...payload, Descripcion: '' } },
    { marking: 'interno', payload: { ...payload, URL_Publicacion: 'javascript:alert(1)' } },
    { marking: 'interno', payload: { Descripcion: 'Reunión de coordinación.' } },
  ])('excludes restricted or unusable/below-threshold evidence %#', async (input) => {
    const { service, create } = setup();
    expect(
      await service.evaluateNarrative(scope, {
        id: 'NAR-SYNTHETIC',
        ...input,
        minimumLevel: 'Media',
      }),
    ).toEqual({ outcome: 'ineligible' });
    expect(create).not.toHaveBeenCalled();
  });
  it('enforces the configured threshold and reports deduplication from the store', async () => {
    const { service, create } = setup();
    const medium = {
      Descripcion: 'Exigimos agua: habrá paro y bloqueo.',
      URL_Publicacion: payload.URL_Publicacion,
    };
    expect(
      await service.evaluateNarrative(scope, {
        id: 'NAR-MEDIA',
        payload: medium,
        marking: 'interno',
        minimumLevel: 'Alta',
      }),
    ).toEqual({ outcome: 'ineligible' });
    expect(create).not.toHaveBeenCalled();
    expect(
      (
        await service.evaluateNarrative(scope, {
          id: 'NAR-MEDIA',
          payload: medium,
          marking: 'interno',
        })
      ).outcome,
    ).toBe('created');
    create.mockImplementation(async (_tenant, alert) => ({
      ...alert,
      id: 'DIG-EXISTING',
      duplicate: true,
      status: 'Corroborado',
      reviewerNote: 'Reviewed',
      reviewedAt: new Date(),
    }));
    expect(
      await service.evaluateNarrative(scope, {
        id: 'NAR-MEDIA',
        payload: medium,
        marking: 'interno',
      }),
    ).toEqual({ outcome: 'duplicate', alertId: 'DIG-EXISTING' });
  });
  it('does not infer territory from narrative text', async () => {
    const { service, create } = setup();
    await service.evaluateNarrative(scope, {
      id: 'NAR-SYNTHETIC',
      payload: { ...payload, Territorio: undefined },
      marking: 'publico',
    });
    expect(create.mock.calls[0]?.[1]).toMatchObject({ territory: null });
  });
});
