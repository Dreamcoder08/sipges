-- Proposals the Inicio analyst made (odd/tasks/agentic-analyst.md S4): a create_record or
-- link_records the model proposed, kept until a person decides it. Nothing is written by
-- proposing; a decision goes through proposal_decisions (fingerprint 'stored:<id>') and its
-- audit row, as for computed proposals, so this table is insert-only and a proposal is pending
-- while no decision names it. The content comes from a model: every text is bounded here too.
--
-- Rollback (no other table references it): DROP TABLE analyst_proposals;

CREATE TABLE analyst_proposals (
  tenant_id     text NOT NULL REFERENCES tenants (tenant_id) ON DELETE CASCADE,
  id            text NOT NULL CHECK (char_length(id) BETWEEN 1 AND 40),
  kind          text NOT NULL CHECK (kind IN ('link', 'record')),
  target_module text NOT NULL CHECK (char_length(target_module) BETWEEN 1 AND 40),
  title         text NOT NULL CHECK (char_length(title) <= 400),
  reason        text NOT NULL CHECK (char_length(reason) <= 600),
  proposal      jsonb NOT NULL CHECK (octet_length(proposal::text) <= 65536),
  proposed_by   text NOT NULL CHECK (char_length(proposed_by) <= 200),
  proposed_at   timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

ALTER TABLE analyst_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE analyst_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON analyst_proposals
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
GRANT SELECT, INSERT ON analyst_proposals TO sipges_tenant;
