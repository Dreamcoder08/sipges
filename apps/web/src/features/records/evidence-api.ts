import { Attachment, AttachmentPreview, AttachmentUploaded } from '@sipges/contracts';
import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import { request, requestJson } from '../../shared/api/client.ts';
import type { RecordModule } from './modules.ts';

export const ACCEPTED_FILES = '.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.jpg,.jpeg,.png,.webp';
export type EvidenceMetadata = {
  documentType: string;
  author: string;
  verification: string;
  notes: string;
};
export const attachmentsQuery = (module: RecordModule, id: string, scope: string) =>
  queryOptions({
    queryKey: ['evidence', scope, module, id],
    staleTime: 0,
    queryFn: ({ signal }) =>
      requestJson(
        `/system/uploads?${new URLSearchParams({ linked_module: module, linked_record_id: id, limit: '500' })}`,
        z.array(Attachment),
        { scope, signal },
      ),
  });
export const uploadAttachment = (
  module: RecordModule,
  id: string,
  scope: string,
  file: File,
  metadata: EvidenceMetadata,
) => {
  if (file.size === 0) throw new Error('El archivo está vacío.');
  const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!ACCEPTED_FILES.split(',').includes(extension))
    throw new Error('Seleccione PDF, Office, CSV, TXT o una imagen admitida.');
  const form = new FormData();
  form.append('file', file);
  form.append('linked_module', module);
  form.append('linked_record_id', id);
  form.append('document_type', metadata.documentType);
  form.append('author', metadata.author);
  form.append('verification', metadata.verification);
  form.append('notes', metadata.notes);
  return requestJson('/system/uploads', AttachmentUploaded, {
    method: 'POST',
    scope,
    body: { multipart: form },
  });
};

/** Ignore supplied download_url: route and scope are always chosen by this client. */
export const downloadAttachment = async (id: string, scope: string) =>
  (await request(`/system/uploads/${encodeURIComponent(id)}/download`, { scope })).blob();

export const previewQuery = (id: string, scope: string) =>
  queryOptions({
    queryKey: ['evidence', scope, 'preview', id],
    queryFn: ({ signal }) =>
      requestJson(`/system/uploads/${encodeURIComponent(id)}/preview`, AttachmentPreview, {
        scope,
        signal,
      }),
  });

/** Images are shown as data: URLs, which the SPA's CSP already allows (no blob: source). */
export const imageDataUrl = async (id: string, scope: string) => {
  const blob = await downloadAttachment(id, scope);
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('No se pudo leer la imagen.'));
    reader.readAsDataURL(blob);
  });
};

/** Evidence of every record of a module, to show which records have files (one request). */
export const moduleAttachmentsQuery = (module: RecordModule, scope: string) =>
  queryOptions({
    queryKey: ['evidence', scope, module, 'all'],
    queryFn: ({ signal }) =>
      requestJson(
        `/system/uploads?${new URLSearchParams({ linked_module: module, limit: '500' })}`,
        z.array(Attachment),
        { scope, signal },
      ),
  });
