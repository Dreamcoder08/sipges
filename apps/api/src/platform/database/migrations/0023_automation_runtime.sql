-- Additive operational evidence; no business-data backfill or deletion.
ALTER TABLE automation_cursors
  ADD COLUMN last_tick_token text,
  ADD COLUMN last_tick_source text CHECK (last_tick_source IN ('event','cron')),
  ADD COLUMN last_tick_started_at timestamptz,
  ADD COLUMN last_tick_finished_at timestamptz,
  ADD COLUMN last_tick_status text CHECK (last_tick_status IN ('running','completed','failed')),
  ADD COLUMN last_tick_report jsonb,
  ADD COLUMN last_tick_error text NOT NULL DEFAULT '';
GRANT UPDATE (last_tick_token,last_tick_source,last_tick_started_at,last_tick_finished_at,last_tick_status,last_tick_report,last_tick_error) ON automation_cursors TO mascli_tenant;
