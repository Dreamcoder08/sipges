import { randomBytes } from 'node:crypto';
import {
  createReferenceService,
  type ReferenceService,
} from './contexts/reference/application/index.ts';
import { fileReferenceReader } from './contexts/reference/infrastructure/file-reference-reader.ts';
import {
  type AnalystService,
  type Narrator,
  createAnalystService,
} from './contexts/analyst/application/index.ts';
import { createClaudeNarrator } from './contexts/analyst/infrastructure/index.ts';
import {
  type AnalyticsService,
  createAnalyticsService,
} from './contexts/analytics/application/index.ts';
import { createSqlAnalyticsRecordReader } from './contexts/analytics/infrastructure/sql-analytics-record-reader.ts';
import {
  type AutomationService,
  type ChannelSender,
  createAutomationService,
} from './contexts/automation/application/index.ts';
import {
  createHttpChannelSender,
  createSqlAutomationStore,
} from './contexts/automation/infrastructure/index.ts';
import {
  type ApiKeyService,
  createApiKeyService,
} from './contexts/integration/application/index.ts';
import { createSqlApiKeyStore, keyCrypto } from './contexts/integration/infrastructure/index.ts';
import { type AuditService, createAuditService } from './contexts/audit/application/index.ts';
import { createSqlAuditReader } from './contexts/audit/infrastructure/sql-audit-reader.ts';
import {
  type DocumentLabService,
  createDocumentLabService,
} from './contexts/documents/application/index.ts';
import {
  createSqlReviewStore,
  documentReader,
  docxRenderer,
} from './contexts/documents/infrastructure/index.ts';
import {
  createIntelligenceService,
  type EmbeddingProvider,
  type IntelligenceService,
} from './contexts/intelligence/application/index.ts';
import {
  createOllamaEmbeddings,
  createSqlAlertStore,
} from './contexts/intelligence/infrastructure/index.ts';
import {
  createManagementService,
  type ManagementService,
} from './contexts/management/application/index.ts';
import {
  createPreventionService,
  type PreventionService,
} from './contexts/prevention/application/index.ts';
import { createSqlActionStore } from './contexts/prevention/infrastructure/index.ts';
import {
  type EvidenceService,
  type ObjectStorage,
  createEvidenceService,
} from './contexts/evidence/application/index.ts';
import {
  createObjectStorage,
  createSqlAttachmentStore,
} from './contexts/evidence/infrastructure/index.ts';
import {
  type Clock,
  type IdentityService,
  createIdentityService,
} from './contexts/identity/application/index.ts';
import { passwordHasher } from './contexts/identity/infrastructure/password-hasher.ts';
import { createSecretCipher } from './contexts/identity/infrastructure/secret-cipher.ts';
import { sessionTokens } from './contexts/identity/infrastructure/session-tokens.ts';
import { createSqlIdentityStore } from './contexts/identity/infrastructure/sql-identity-store.ts';
import { createGoogleSignIn } from './contexts/identity/infrastructure/google-oidc.ts';
import type { GoogleSignIn } from './contexts/identity/application/ports.ts';
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
import {
  createOntologyService,
  type OntologyService,
} from './contexts/ontology/application/index.ts';
import { createSqlOntologyStore } from './contexts/ontology/infrastructure/sql-ontology-store.ts';
import {
  RECORD_MODULES,
  createRecordsService,
  type RecordsService,
} from './contexts/records/application/index.ts';
import { createSqlRecordStore } from './contexts/records/infrastructure/sql-record-store.ts';
import { createTenancyService, type TenancyService } from './contexts/tenancy/application/index.ts';
import { createSqlTenantDataReader } from './contexts/tenancy/infrastructure/sql-tenant-data-reader.ts';
import { createSqlTenancyStore } from './contexts/tenancy/infrastructure/sql-tenancy-store.ts';
import type { AppConfig } from './platform/config.ts';
import type { SqlClient } from './platform/database/sql-client.ts';
import type { ClientIp } from './platform/http/env.ts';

export type Container = {
  readonly reference: ReferenceService;
  readonly config: AppConfig;
  readonly identity: IdentityService;
  /** Present only when a Google OAuth client is configured (ADR 0010). */
  readonly googleSignIn: GoogleSignIn | undefined;
  readonly tenancy: TenancyService;
  readonly records: RecordsService;
  readonly ontology: OntologyService;
  readonly analyst: AnalystService;
  readonly audit: AuditService;
  readonly indicators: IndicatorsService;
  readonly analytics: AnalyticsService;
  readonly evidence: EvidenceService;
  readonly documents: DocumentLabService;
  readonly intelligence: IntelligenceService;
  readonly prevention: PreventionService;
  readonly management: ManagementService;
  readonly automation: AutomationService;
  readonly apiKeys: ApiKeyService;
  readonly clientIp: ClientIp;
};

const randomHex = (length: number) =>
  randomBytes(Math.ceil(length / 2))
    .toString('hex')
    .slice(0, length);

/** Wires adapters into use cases (manual constructor injection, docs/adr/0002). */
export const buildContainer = async (deps: {
  config: AppConfig;
  sql: SqlClient;
  clock: Clock;
  clientIp: ClientIp;
  /** Overrides the configured adapter (tests inject failing or in-memory storage). */
  objectStorage?: ObjectStorage;
  /** Overrides the Ollama adapter (tests inject a deterministic or failing provider). */
  embeddings?: EmbeddingProvider;
  /** Overrides the configured narrator (tests inject a deterministic or failing one). */
  narrator?: Narrator | null;
  /** Overrides the Google client (tests inject a fake identity provider). */
  googleSignIn?: GoogleSignIn;
  /** Overrides outbound HTTP for automation channels (tests record messages instead). */
  channelSender?: ChannelSender;
}): Promise<Container> => {
  const cipher = createSecretCipher(deps.config.dataKey);
  const identity = createIdentityService({
    store: createSqlIdentityStore(deps.sql),
    hasher: passwordHasher,
    totp,
    cipher,
    tokens: sessionTokens,
    clock: deps.clock,
  });
  await identity.bootstrapAdmin(deps.config.admin);
  if (deps.config.google?.adminEmail) {
    await identity.bootstrapGoogleAdmin(deps.config.admin.username, deps.config.google.adminEmail);
  }
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
    randomHex: (length) => randomHex(length).toUpperCase(),
  });
  const ontology = createOntologyService({
    store: createSqlOntologyStore(deps.sql),
    clock: deps.clock,
  });
  const analyst = createAnalystService({
    source: {
      async neighbours(tenantId, slug, id) {
        const found = await ontology.neighbours(tenantId, slug, id);
        return found
          ? {
              subject: found.record,
              connections: found.neighbours.map((n) => ({
                linkType: n.edge.linkType,
                label: n.label,
                inferred: n.edge.inferred,
                other: n.other,
              })),
            }
          : null;
      },
    },
    narrator:
      deps.narrator !== undefined
        ? deps.narrator
        : deps.config.analyst
          ? createClaudeNarrator({ model: deps.config.analyst.model })
          : null,
    clock: deps.clock,
  });
  const audit = createAuditService(createSqlAuditReader(deps.sql));
  const indicators = createIndicatorsService({
    records: createSqlModuleRecordReader(deps.sql),
    configs: createSqlIrsaConfigStore(deps.sql),
    snapshots: createSqlIrsaSnapshotStore(deps.sql),
    clock: deps.clock,
  });
  const recordReader = createSqlAnalyticsRecordReader(deps.sql);
  const analytics = createAnalyticsService({
    reader: recordReader,
    clock: deps.clock,
    renderer: docxRenderer,
  });
  const evidence = createEvidenceService({
    storage: deps.objectStorage ?? createObjectStorage(deps.config.storage),
    store: createSqlAttachmentStore(deps.sql),
    clock: deps.clock,
    randomHex,
    maxUploadBytes: deps.config.maxUploadBytes,
  });
  const documents = createDocumentLabService({
    reader: documentReader,
    renderer: docxRenderer,
    reviews: createSqlReviewStore(deps.sql),
    clock: deps.clock,
    randomHex,
    maxUploadBytes: deps.config.maxUploadBytes,
  });
  const intelligence = createIntelligenceService({
    narratives: {
      read: async (scope) =>
        ((await recordReader.read(scope, ['Narrativas']))['Narrativas'] ?? []).map(
          (r) => r.payload,
        ),
    },
    embeddings: deps.embeddings ?? createOllamaEmbeddings(deps.config.ollama),
    alerts: createSqlAlertStore(deps.sql),
    clock: deps.clock,
    randomHex,
  });
  const prevention = createPreventionService({
    store: createSqlActionStore(deps.sql),
    alerts: { status: (scope, id) => intelligence.alertStatus(scope, id) },
    clock: deps.clock,
    randomHex,
  });
  const iso = (date: Date) => `${date.toISOString().slice(0, 19)}Z`;
  const management = createManagementService({
    sources: {
      alerts: async (scope) =>
        (await intelligence.allAlerts(scope)).map((a) => ({
          id: a.id,
          createdAt: iso(a.createdAt),
          sourceUrl: a.sourceUrl,
          sourceType: a.sourceType,
          level: a.level,
          score: a.score,
          status: a.status,
          reviewedAt: a.reviewedAt ? iso(a.reviewedAt) : null,
        })),
      actions: async (scope) =>
        (await prevention.list(scope)).map((a) => ({
          id: a.id,
          alertId: a.alertId,
          title: a.title,
          responsible: a.responsible,
          dueDate: a.dueDate,
          status: a.status,
          progress: a.progress,
          updatedAt: iso(a.updatedAt),
        })),
      commitmentRecords: async (scope) =>
        (await recordReader.read(scope, ['Compromisos']))['Compromisos'] ?? [],
    },
    clock: deps.clock,
  });
  const automation = createAutomationService({
    store: createSqlAutomationStore(deps.sql),
    sender: deps.channelSender ?? createHttpChannelSender(),
    sealer: cipher,
    clock: deps.clock,
    recordModules: RECORD_MODULES.map((m) => m.module),
  });
  return {
    reference: createReferenceService(fileReferenceReader),
    config: deps.config,
    identity,
    googleSignIn:
      deps.googleSignIn ??
      (deps.config.google ? createGoogleSignIn(deps.config.google) : undefined),
    tenancy,
    records,
    ontology,
    analyst,
    audit,
    indicators,
    analytics,
    evidence,
    documents,
    intelligence,
    prevention,
    management,
    automation,
    apiKeys: createApiKeyService({
      store: createSqlApiKeyStore(deps.sql),
      crypto: keyCrypto,
      clock: deps.clock,
    }),
    clientIp: deps.clientIp,
  };
};
