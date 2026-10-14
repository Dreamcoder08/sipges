import { z } from 'zod';

/** Public attachment metadata. Storage keys and provider credentials never enter the client. */
export const Attachment = z.object({
  id: z.string(),
  original_name: z.string(),
  content_type: z.string(),
  size_bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  linked_module: z.string(),
  linked_record_id: z.string(),
  document_type: z.string(),
  author: z.string(),
  verification: z.string(),
  notes: z.string(),
  project_id: z.string(),
  project_name: z.string(),
  created_at: z.string(),
});
export type Attachment = z.infer<typeof Attachment>;
export const AttachmentUploaded = z.object({ ok: z.literal(true), attachment: Attachment });

/** GET /system/uploads/{id}/preview: what the in-app viewer can show of an evidence file. */
export const AttachmentPreview = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    format: z.enum(['pdf', 'docx', 'txt', 'csv']),
    pages: z.array(z.string()),
    truncated: z.boolean(),
    attachment: Attachment,
  }),
  z.object({
    kind: z.enum(['image', 'no_text', 'too_long', 'unsupported']),
    attachment: Attachment,
  }),
]);
export type AttachmentPreview = z.infer<typeof AttachmentPreview>;
