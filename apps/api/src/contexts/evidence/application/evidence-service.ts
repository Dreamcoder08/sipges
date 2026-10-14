import { createHash } from 'node:crypto';
import { type Result, err, ok } from '@mascli/kernel';
import { moduleForSlug } from '../../records/application/index.ts';
import {
  type Attachment,
  DEFAULT_DOCUMENT_TYPE,
  DEFAULT_VERIFICATION,
  METADATA_LIMITS,
  type UploadRejection,
  checkUpload,
} from '../domain/index.ts';
import { extensionOf } from '../domain/index.ts';
import type {
  AttachmentQuery,
  AttachmentStore,
  Clock,
  ObjectStorage,
  RandomHex,
  TextExtractor,
} from './ports.ts';

export const MAX_LIST_LIMIT = 500;

export type UploadInput = {
  readonly tenantId: string;
  readonly scopeProjectId: string;
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly linkedModule: string;
  readonly linkedRecordId: string;
  readonly documentType?: string | undefined;
  readonly author?: string | undefined;
  readonly verification?: string | undefined;
  readonly notes?: string | undefined;
};

export type UploadError =
  UploadRejection | { readonly kind: 'module' } | { readonly kind: 'record' };

export type Download =
  | { readonly kind: 'file'; readonly attachment: Attachment; readonly bytes: Uint8Array }
  | { readonly kind: 'missing_metadata' }
  | { readonly kind: 'missing_object' };

/** Viewer limits: enough to read a report, bounded so one request cannot blow up memory. */
export const PREVIEW_MAX_PAGES = 60;
export const PREVIEW_MAX_CHARS = 200_000;

export type PreviewFormat = 'pdf' | 'docx' | 'txt' | 'csv';
export type Preview =
  | { readonly kind: 'missing_metadata' }
  | { readonly kind: 'missing_object'; readonly attachment: Attachment }
  /** Text the browser shows; `truncated` when a limit cut it. */
  | {
      readonly kind: 'text';
      readonly attachment: Attachment;
      readonly format: PreviewFormat;
      readonly pages: readonly string[];
      readonly truncated: boolean;
    }
  /** Images are shown from the download itself. */
  | { readonly kind: 'image'; readonly attachment: Attachment }
  /** Readable format but no text layer or unreadable bytes (e.g. a scanned PDF). */
  | { readonly kind: 'no_text'; readonly attachment: Attachment }
  /** A PDF over PREVIEW_MAX_PAGES pages: download only. */
  | { readonly kind: 'too_long'; readonly attachment: Attachment }
  /** Formats without an in-app viewer (legacy .doc, spreadsheets): download only. */
  | { readonly kind: 'unsupported'; readonly attachment: Attachment };

const clip = (pages: readonly string[]) => {
  const out: string[] = [];
  let left = PREVIEW_MAX_CHARS;
  for (const page of pages) {
    if (left <= 0) return { pages: out, truncated: true };
    out.push(page.slice(0, left));
    left -= page.length;
  }
  return { pages: out, truncated: left < 0 };
};

/** PostgreSQL text cannot hold NUL; such input can never match a stored value. */
const storable = (value: string | null) => value === null || !value.includes('\u0000');

/** Tenants never share an object prefix, even if a key were guessed. */
const tenantPrefix = (tenantId: string) =>
  createHash('sha256').update(tenantId).digest('hex').slice(0, 24);

export const createEvidenceService = (deps: {
  storage: ObjectStorage;
  store: AttachmentStore;
  clock: Clock;
  randomHex: RandomHex;
  maxUploadBytes: number;
  text: TextExtractor;
}) => {
  const { storage, store, clock, randomHex, maxUploadBytes, text } = deps;

  return {
    maxUploadBytes,

    /**
     * Stores the object first, then commits metadata + record link + audit in one transaction.
     * If the record is missing or the transaction fails, the object is deleted again, so a
     * failed upload leaves neither an orphan file nor a dangling row (docs/adr/0008 #9).
     */
    async upload(input: UploadInput): Promise<Result<Attachment, UploadError>> {
      const moduleSlug = input.linkedModule.trim().toLowerCase();
      const recordModule = moduleForSlug(moduleSlug);
      if (!recordModule) return err({ kind: 'module' });
      // A record id PostgreSQL cannot store (NUL, over 200 characters) can never be linked.
      if (input.linkedRecordId.includes('\u0000') || input.linkedRecordId.length > 200)
        return err({ kind: 'record' });
      const checked = checkUpload(input.fileName, input.bytes, maxUploadBytes);
      if (!checked.ok) return err(checked.error);
      const { safeName, contentType } = checked.value;

      const id = `ADJ-${randomHex(12).toUpperCase()}`;
      const storageKey = `${tenantPrefix(input.tenantId)}/${randomHex(32).toLowerCase()}_${safeName}`;
      await storage.put(storageKey, input.bytes, contentType);
      let attachment: Attachment | null;
      try {
        attachment = await store.attach(input.tenantId, {
          id,
          storageKey,
          originalName: safeName,
          contentType,
          sizeBytes: input.bytes.length,
          sha256: createHash('sha256').update(input.bytes).digest('hex'),
          linkedModule: moduleSlug,
          linkedRecordId: input.linkedRecordId,
          recordModule,
          documentType: (input.documentType ?? DEFAULT_DOCUMENT_TYPE).slice(
            0,
            METADATA_LIMITS.documentType,
          ),
          author: (input.author ?? '').slice(0, METADATA_LIMITS.author),
          verification: (input.verification ?? DEFAULT_VERIFICATION).slice(
            0,
            METADATA_LIMITS.verification,
          ),
          notes: (input.notes ?? '').slice(0, METADATA_LIMITS.notes),
          scopeProjectId: input.scopeProjectId,
          createdAt: clock.now(),
        });
      } catch (error) {
        await storage.delete(storageKey).catch(() => undefined);
        throw error;
      }
      if (!attachment) {
        await storage.delete(storageKey);
        return err({ kind: 'record' });
      }
      return ok(attachment);
    },

    async list(tenantId: string, query: AttachmentQuery): Promise<Attachment[]> {
      if (![query.linkedModule, query.linkedRecordId, query.q].every(storable)) return [];
      return store.list(tenantId, {
        linkedModule: query.linkedModule?.trim().toLowerCase() || null,
        linkedRecordId: query.linkedRecordId || null,
        q: query.q || null,
        limit: Math.max(1, Math.min(query.limit, MAX_LIST_LIMIT)),
      });
    },

    async get(tenantId: string, id: string): Promise<Attachment | null> {
      return storable(id) && id.length <= 64 ? store.get(tenantId, id) : null;
    },

    async download(tenantId: string, id: string): Promise<Download> {
      const attachment = storable(id) && id.length <= 64 ? await store.get(tenantId, id) : null;
      if (!attachment) return { kind: 'missing_metadata' };
      const bytes = await storage.get(attachment.storageKey);
      return bytes ? { kind: 'file', attachment, bytes } : { kind: 'missing_object' };
    },

    /** Content of a stored evidence file for the in-app viewer (functional audit, error 05). */
    async preview(tenantId: string, id: string): Promise<Preview> {
      const attachment = storable(id) && id.length <= 64 ? await store.get(tenantId, id) : null;
      if (!attachment) return { kind: 'missing_metadata' };
      const extension = extensionOf(attachment.originalName);
      if (['.jpg', '.jpeg', '.png', '.webp'].includes(extension))
        return { kind: 'image', attachment };
      const format = ({ '.pdf': 'pdf', '.docx': 'docx', '.txt': 'txt', '.csv': 'csv' } as const)[
        extension as '.pdf' | '.docx' | '.txt' | '.csv'
      ];
      if (!format) return { kind: 'unsupported', attachment };
      const bytes = await storage.get(attachment.storageKey);
      if (!bytes) return { kind: 'missing_object', attachment };
      let pages: readonly string[] | null;
      try {
        pages =
          format === 'pdf'
            ? await text.pdf(bytes, PREVIEW_MAX_PAGES)
            : format === 'docx'
              ? [(await text.docx(bytes)).join('\n')]
              : [new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '')];
      } catch {
        return { kind: 'no_text', attachment };
      }
      if (pages === null) return { kind: 'too_long', attachment };
      if (!pages.some((page) => page.trim())) return { kind: 'no_text', attachment };
      return { kind: 'text', attachment, format, ...clip(pages) };
    },
  };
};

export type EvidenceService = ReturnType<typeof createEvidenceService>;
