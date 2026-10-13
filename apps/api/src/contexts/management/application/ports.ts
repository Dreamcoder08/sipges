import type { Scope } from '../../tenancy/application/index.ts';
import type { ActionRow, AlertRow } from '../domain/index.ts';

export type Clock = { now(): Date };

/**
 * Read model fed by the Digital Intelligence, Prevention and Records contexts. Alerts come
 * newest first, actions by due date ascending, records with their payloads.
 */
export type ManagementSources = {
  alerts(scope: Scope): Promise<readonly AlertRow[]>;
  actions(scope: Scope): Promise<readonly ActionRow[]>;
  commitmentRecords(
    scope: Scope,
  ): Promise<readonly { id: string; payload: Readonly<Record<string, unknown>> }[]>;
};
