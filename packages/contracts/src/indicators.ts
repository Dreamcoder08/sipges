import { z } from 'zod';

const NUL_MESSAGE = { message: 'Text must not contain NUL characters' };
const Weights = z.record(z.string(), z.number());
const Band = z.tuple([z.number(), z.number()]);

/**
 * POST /system/irsa/config body (app.py RecordIn). Only `weights`, `thresholds` and
 * `contributions` are applied; other payload keys are ignored, as in Python.
 */
export const IrsaConfigUpdate = z.object({
  payload: z.object({
    weights: Weights.optional(),
    thresholds: z.record(z.string(), Band).optional(),
    contributions: z.record(z.string(), z.number()).optional(),
  }),
});
export type IrsaConfigUpdate = z.infer<typeof IrsaConfigUpdate>;

/** POST /system/irsa/snapshot body (app.py RecordIn); `note` is stored as `str(note or "")`. */
export const IrsaSnapshotCreate = z.object({
  payload: z
    .object({ note: z.unknown().optional() })
    .refine((p) => !String(p.note ?? '').includes('\u0000'), NUL_MESSAGE),
});
export type IrsaSnapshotCreate = z.infer<typeof IrsaSnapshotCreate>;

/** GET /system/irsa/history query; a negative limit returns every snapshot (SQLite LIMIT -1). */
export const IrsaHistoryQuery = z.object({
  limit: z.coerce.number().int().default(50),
});
export type IrsaHistoryQuery = z.infer<typeof IrsaHistoryQuery>;

/** One GET /system/irsa/history item (app.py irsa_snapshots row). */
export const IrsaSnapshotRow = z.object({
  id: z.number().int(),
  ts: z.string(),
  irsa: z.number(),
  level: z.string(),
  scores: z.record(z.string(), z.number()),
  config_version: z.string().nullable(),
  note: z.string().nullable(),
});
export type IrsaSnapshotRow = z.infer<typeof IrsaSnapshotRow>;

/** GET /system/irsa/config and the `config` of a successful POST. */
export const IrsaConfig = z
  .object({
    weights: Weights,
    thresholds: z.record(z.string(), Band),
    contributions: z.record(z.string(), z.number()),
  })
  .loose();
export type IrsaConfig = z.infer<typeof IrsaConfig>;
