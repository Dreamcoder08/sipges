/** Evidence file metadata linked to one territorial record of a tenant. */
export type Attachment = {
  readonly id: string;
  readonly storageKey: string;
  readonly originalName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  /** URL slug of the linked module, e.g. `eventos` (app.py stores the slug). */
  readonly linkedModule: string;
  readonly linkedRecordId: string;
  readonly documentType: string;
  readonly author: string;
  readonly verification: string;
  readonly notes: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly createdAt: Date;
};

/** Default project of the migrated installation and its display name (app.py parity). */
const LEGACY_PROJECT = { id: 'PRJ-SECHURA', name: 'Proyecto Sechura' } as const;

/**
 * Project shown on an attachment: the linked record's own `Proyecto_ID`/`Proyecto`, else the
 * active scope's project (docs/adr/0008 #6 — never a hard-coded default project).
 */
export const projectOf = (
  payload: Readonly<Record<string, unknown>>,
  scopeProjectId: string,
): { projectId: string; projectName: string } => {
  const projectId = String(payload.Proyecto_ID || scopeProjectId);
  const named = payload.Proyecto ? String(payload.Proyecto) : '';
  return {
    projectId,
    projectName: named || (projectId === LEGACY_PROJECT.id ? LEGACY_PROJECT.name : ''),
  };
};

/** Fields app.py writes back into the linked record when a file is attached. */
export const linkIntoPayload = (
  payload: Readonly<Record<string, unknown>>,
  moduleSlug: string,
  link: { id: string; fileName: string; documentType: string; verification: string },
): Record<string, unknown> => {
  const current = Array.isArray(payload.Adjuntos) ? payload.Adjuntos : [];
  const next: Record<string, unknown> = {
    ...payload,
    Adjuntos: [
      ...current,
      {
        id: link.id,
        archivo: link.fileName,
        tipo: link.documentType,
        verificacion: link.verification,
      },
    ],
  };
  if (moduleSlug === 'eventos') next['Evidencia/Resultado'] = link.fileName;
  if (moduleSlug === 'fuentes') next.Archivo_Fuente = link.fileName;
  return next;
};
