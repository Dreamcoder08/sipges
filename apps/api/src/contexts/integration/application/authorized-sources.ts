import { createHash } from 'node:crypto';
import {
  AuthorizedSourceConfigIn,
  AuthorizedSourceImportIn,
  type AuthorizedSourceState,
  type OfficialSourcePost,
} from '@mascli/contracts';
export type OfficialSourceGateway = {
  preview(query: string): Promise<OfficialSourcePost[]>;
  get(id: number): Promise<OfficialSourcePost>;
};
export type SourceSettingsStore = {
  get(tenantId: string): Promise<AuthorizedSourceState>;
  save(
    tenantId: string,
    input: AuthorizedSourceConfigIn,
    username: string,
    at: string,
  ): Promise<AuthorizedSourceState>;
  claimPoll(tenantId: string, revision: number, at: string): Promise<boolean>;
  finishPoll(
    tenantId: string,
    at: string,
    outcome: { imported: number; duplicates: number; error: string },
  ): Promise<void>;
  activeTenants(): Promise<string[]>;
};
export type SourceImporter = {
  createOnce(
    tenantId: string,
    canonicalId: string,
    payload: Record<string, unknown>,
  ): Promise<{ id: string; created: boolean }>;
};
export const emptySourceState = (): AuthorizedSourceState => ({
  enabled: false,
  query: '',
  territory: '',
  authorization_note: '',
  revision: 0,
  updated_by: '',
  updated_at: null,
  last_poll_at: null,
  last_poll_error: '',
  last_imported: 0,
  last_duplicates: 0,
});
export const createAuthorizedSourcesService = (deps: {
  gateway: OfficialSourceGateway;
  settings: SourceSettingsStore;
  importer: SourceImporter;
  clock?: () => Date;
}) => {
  const clock = deps.clock ?? (() => new Date());
  const importMetadata = async (tenantId: string, post: OfficialSourcePost, territory?: string) => {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([post.id, post.url, post.title, post.excerpt, post.published_at]))
      .digest('hex');
    return deps.importer.createOnce(tenantId, `SRC-DEF-${post.id}-${fingerprint.slice(0, 16)}`, {
      Descripcion: `${post.title}\n\n${post.excerpt}`,
      URL_Publicacion: post.url,
      'Plataforma/Fuente': 'Defensoría del Pueblo del Perú',
      Tipo_Fuente: 'Publicación digital',
      Fuente_Integracion: 'defensoria',
      Fuente_Huella_SHA256: fingerprint,
      Fuente_ID_Externo: String(post.id),
      Fuente_Publicada_En: post.published_at,
      Fuente_Observada_En: clock().toISOString(),
      ...(territory?.trim() ? { Territorio: territory.trim() } : {}),
    });
  };
  return {
    activeTenants: () => deps.settings.activeTenants(),
    catalog: async (tenantId: string) => ({
      id: 'defensoria' as const,
      name: 'Defensoría del Pueblo del Perú',
      url: 'https://www.defensoria.gob.pe/',
      checked_at: '2026-10-17',
      attribution:
        'Publicaciones oficiales de la Defensoría del Pueblo. Solo título y extracto; disponibilidad externa variable. Pendientes de verificación humana.',
      state: await deps.settings.get(tenantId),
    }),
    preview: (query: string) => deps.gateway.preview(query),
    configure: async (tenantId: string, input: AuthorizedSourceConfigIn, username: string) => {
      const config = AuthorizedSourceConfigIn.parse(input);
      if (config.enabled && !config.authorization_note.trim())
        throw new Error('Se requiere una nota de autorización explícita');
      return deps.settings.save(tenantId, config, username, clock().toISOString());
    },
    importPost: async (tenantId: string, input: AuthorizedSourceImportIn) => {
      const parsed = AuthorizedSourceImportIn.parse(input);
      return importMetadata(tenantId, await deps.gateway.get(parsed.post_id), parsed.territory);
    },
    poll: async (tenantId: string) => {
      const config = await deps.settings.get(tenantId);
      const at = clock().toISOString();
      if (!config.enabled || !(await deps.settings.claimPoll(tenantId, config.revision, at)))
        return { skipped: true, imported: 0, duplicates: 0 };
      let imported = 0;
      let duplicates = 0;
      try {
        for (const post of (await deps.gateway.preview(config.query)).slice(0, 10)) {
          const current = await deps.settings.get(tenantId);
          if (!current.enabled || current.revision !== config.revision) break;
          const result = await importMetadata(tenantId, post, config.territory);
          if (result.created) imported++;
          else duplicates++;
        }
        await deps.settings.finishPoll(tenantId, at, { imported, duplicates, error: '' });
        return { skipped: false, imported, duplicates };
      } catch (error) {
        const code =
          error instanceof Error && /^source_[a-z_]+$/.test(error.message)
            ? error.message
            : 'source_poll_failed';
        await deps.settings.finishPoll(tenantId, at, { imported, duplicates, error: code });
        throw new Error(code, { cause: error });
      }
    },
  };
};
export type AuthorizedSourcesService = ReturnType<typeof createAuthorizedSourcesService>;
