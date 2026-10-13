import { Attachment, AttachmentUploaded } from '@mascli/contracts';
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
