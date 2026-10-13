import { randomBytes } from 'node:crypto';
import {
  type AnalyticsService,
  createAnalyticsService,
} from './contexts/analytics/application/index.ts';
import { createSqlAnalyticsRecordReader } from './contexts/analytics/infrastructure/sql-analytics-record-reader.ts';
import { type AuditService, createAuditService } from './contexts/audit/application/index.ts';
import { createSqlAuditReader } from './contexts/audit/infrastructure/sql-audit-reader.ts';
import {
  type Clock,
  type IdentityService,
  createIdentityService,
} from './contexts/identity/application/index.ts';
import { passwordHasher } from './contexts/identity/infrastructure/password-hasher.ts';
import { createSecretCipher } from './contexts/identity/infrastructure/secret-cipher.ts';
import { sessionTokens } from './contexts/identity/infrastructure/session-tokens.ts';
import { createSqlIdentityStore } from './contexts/identity/infrastructure/sql-identity-store.ts';
import { totp } from './contexts/identity/infrastructure/totp.ts';
import {
  createIndicatorsService,
  type IndicatorsService,
} from './contexts/indicators/application/index.ts';
import {
  createSqlIrsaConfigStore,
  createSqlIrsaSnapshotStore,
  createSqlModuleRecordReader,
} from './contexts/indicators/infrastructure/index.ts';
import { createRecordsService, type RecordsService } from './contexts/records/application/index.ts';
import { createSqlRecordStore } from './contexts/records/infrastructure/sql-record-store.ts';
import { createTenancyService, type TenancyService } from './contexts/tenancy/application/index.ts';
import { createSqlTenantDataReader } from './contexts/tenancy/infrastructure/sql-tenant-data-reader.ts';
import { createSqlTenancyStore } from './contexts/tenancy/infrastructure/sql-tenancy-store.ts';
import type { AppConfig } from './platform/config.ts';
import type { SqlClient } from './platform/database/sql-client.ts';
import type { ClientIp } from './platform/http/env.ts';

export type Container = {
  readonly config: AppConfig;
  readonly identity: IdentityService;
  readonly tenancy: TenancyService;
  readonly records: RecordsService;
  readonly audit: AuditService;
  readonly indicators: IndicatorsService;
  readonly analytics: AnalyticsService;
  readonly clientIp: ClientIp;
};

/** Wires adapters into use cases (manual constructor injection, docs/adr/0002). */
export const buildContainer = async (deps: {
  config: AppConfig;
  sql: SqlClient;
  clock: Clock;
  clientIp: ClientIp;
}): Promise<Container> => {
  const identity = createIdentityService({
    store: createSqlIdentityStore(deps.sql),
    hasher: passwordHasher,
    totp,
    cipher: createSecretCipher(deps.config.dataKey),
    tokens: sessionTokens,
    clock: deps.clock,
  });
  await identity.bootstrapAdmin(deps.config.admin);
  const tenancy = createTenancyService({
    store: createSqlTenancyStore(deps.sql),
    dataReader: createSqlTenantDataReader(deps.sql),
    users: {
      exists: (username) => identity.userExists(username),
      adminUsernames: async () =>
        (await identity.listAccounts())
          .filter((user) => user.role === 'admin')
          .map((user) => user.username),
    },
    clock: deps.clock,
  });
  await tenancy.bootstrap();
  const records = createRecordsService({
    store: createSqlRecordStore(deps.sql),
    clock: deps.clock,
    randomHex: (length) =>
      randomBytes(Math.ceil(length / 2))
        .toString('hex')
        .slice(0, length)
        .toUpperCase(),
  });
  const audit = createAuditService(createSqlAuditReader(deps.sql));
  const indicators = createIndicatorsService({
    records: createSqlModuleRecordReader(deps.sql),
    configs: createSqlIrsaConfigStore(deps.sql),
    snapshots: createSqlIrsaSnapshotStore(deps.sql),
    clock: deps.clock,
  });
  const analytics = createAnalyticsService({
    reader: createSqlAnalyticsRecordReader(deps.sql),
    clock: deps.clock,
  });
  return {
    config: deps.config,
    identity,
    tenancy,
    records,
    audit,
    indicators,
    analytics,
    clientIp: deps.clientIp,
  };
};
