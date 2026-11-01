import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ES module used by the deploy job, without type declarations.
import { describeMigrationFailure } from '../migration-failure.mjs';

const serverError = (message: string, code: string) =>
  Object.assign(new Error(message), { name: 'PostgresError', code });

describe('describeMigrationFailure', () => {
  it('prints the server message and SQLSTATE so the deploy log shows why a migration stopped', () => {
    const cause = serverError(
      'Cannot remove tenant MASCLI/PRJ-SECHURA: table project_settings already holds the same key under SIPGES/PRJ-SECHURA',
      '23505',
    );
    const error = new Error('Migration 0031_remove_mascli_tenant failed', { cause });
    expect(describeMigrationFailure(error)).toEqual([
      'Migration 0031_remove_mascli_tenant failed',
      'Cause: PostgresError 23505: Cannot remove tenant MASCLI/PRJ-SECHURA: table project_settings already holds the same key under SIPGES/PRJ-SECHURA',
    ]);
  });

  it('keeps client-side causes to their class, so a connection error never prints the URL', () => {
    const cause = new Error('connect ECONNREFUSED postgres://user:secret@db.example:5432/app');
    const error = new Error('Migration 0031_remove_mascli_tenant failed', { cause });
    const lines = describeMigrationFailure(error);
    expect(lines).toEqual(['Migration 0031_remove_mascli_tenant failed', 'Cause: Error']);
    expect(lines.join('\n')).not.toContain('secret');
  });

  it('ignores a code that is not a SQLSTATE', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND db.example'), {
      code: 'ENOTFOUND',
    });
    expect(describeMigrationFailure(new Error('Migration failed', { cause }))).toEqual([
      'Migration failed',
      'Cause: Error',
    ]);
  });

  it('describes a value that is not an Error', () => {
    expect(describeMigrationFailure('boom')).toEqual(['Migration failed']);
  });
});
