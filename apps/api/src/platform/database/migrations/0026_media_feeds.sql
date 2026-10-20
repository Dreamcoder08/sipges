-- Media monitoring by public RSS/Atom feeds (docs/adr/0021). Feeds are polled by the
-- automation cron only while the project has MASCLI 4.0 on; items become Narrativas.
CREATE TABLE media_feeds (
  tenant_id          text NOT NULL REFERENCES tenants (tenant_id) ON DELETE CASCADE,
  id                 integer GENERATED ALWAYS AS IDENTITY,
  name               text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  url                text NOT NULL CHECK (char_length(url) BETWEEN 9 AND 500 AND url LIKE 'https://%'),
  keywords           jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(keywords) = 'array'),
  territory          text NOT NULL DEFAULT '' CHECK (char_length(territory) <= 200),
  authorization_note text NOT NULL CHECK (char_length(btrim(authorization_note)) BETWEEN 1 AND 1000),
  enabled            boolean NOT NULL DEFAULT true,
  updated_by         text NOT NULL,
  updated_at         timestamptz NOT NULL,
  last_poll_at       timestamptz,
  last_poll_error    text NOT NULL DEFAULT '',
  last_imported      integer NOT NULL DEFAULT 0,
  last_matched       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, url)
);

ALTER TABLE media_feeds ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_feeds FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON media_feeds
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON media_feeds TO mascli_tenant;
