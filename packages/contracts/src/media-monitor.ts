import { z } from 'zod';

/** Media monitoring by public RSS/Atom feeds (docs/adr/0021). */
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !value.includes('\0'));

export const MediaFeedIn = z.object({
  name: text(120).min(1),
  url: text(500).min(1),
  /** Empty: every new item of the feed becomes a narrative. */
  keywords: z.array(text(60).min(1)).max(30).default([]),
  territory: text(200).default(''),
  /** Who authorized reading this source and why; required, as for the Defensoría connector. */
  authorization_note: text(1000).min(1),
  enabled: z.boolean().default(true),
});
export type MediaFeedIn = z.infer<typeof MediaFeedIn>;

export const MediaFeed = z.object({
  id: z.number().int(),
  name: z.string(),
  url: z.string(),
  keywords: z.array(z.string()),
  territory: z.string(),
  authorization_note: z.string(),
  enabled: z.boolean(),
  updated_by: z.string(),
  updated_at: z.string(),
  last_poll_at: z.string().nullable(),
  last_poll_error: z.string(),
  last_imported: z.number(),
  last_matched: z.number(),
});
export type MediaFeed = z.infer<typeof MediaFeed>;

export const MediaMonitorState = z.object({
  /** Feeds are only polled while MASCLI 4.0 is on. */
  active: z.boolean(),
  poll_minutes: z.number(),
  max_feeds: z.number(),
  feeds: z.array(MediaFeed),
});
export type MediaMonitorState = z.infer<typeof MediaMonitorState>;

export const MediaFeedPreviewItem = z.object({
  title: z.string(),
  link: z.string(),
  summary: z.string(),
  published_at: z.string().nullable(),
  matched: z.array(z.string()),
});
export const MediaFeedPreview = z.object({
  items: z.array(MediaFeedPreviewItem),
  total: z.number(),
});
export type MediaFeedPreview = z.infer<typeof MediaFeedPreview>;

export const MediaPollReport = z.object({
  feeds: z.number(),
  imported: z.number(),
  duplicates: z.number(),
  errors: z.number(),
});
export type MediaPollReport = z.infer<typeof MediaPollReport>;
