import {
  createGeographyService,
  type GeographyGateway,
  type GeographyService,
} from './contexts/geography/application/index.ts';
import { createIngemmetGateway } from './contexts/geography/infrastructure/index.ts';
import { createPostgisSpatialEngine } from './contexts/geography/infrastructure/spatial-engine.ts';
import {
  createAuthorizedSourcesService,
  type AuthorizedSourcesService,
  type OfficialSourceGateway,
  type SourceImporter,
} from './contexts/integration/application/index.ts';
import {
  createMediaMonitorService,
  type FeedGateway,
  type MediaMonitorService,
} from './contexts/integration/application/media-monitor.ts';
import {
  createOfficialSourceGateway,
  createRssFeedGateway,
  createSqlMediaFeeds,
  createSqlSourceSettings,
} from './contexts/integration/infrastructure/index.ts';
import {
  createAutomationRuntime,
  type AutomationRuntime,
} from './contexts/system/application/index.ts';
import { createSqlAutomationRuntimeStore } from './contexts/system/infrastructure/index.ts';
import { formatScope, parseScope } from './contexts/tenancy/application/index.ts';
import { runWithRequestContext } from './platform/request-context.ts';
import { log } from './platform/observability/logger.ts';
import { randomBytes, randomUUID } from 'node:crypto';
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
import {
  createClaudeNarrator,
  createSqlProposalStore,
} from './contexts/analyst/infrastructure/index.ts';
import {
  type AnalyticsService,
  createAnalyticsService,
} from './contexts/analytics/application/index.ts';
import { createSqlAnalyticsRecordReader } from './contexts/analytics/infrastructure/sql-analytics-record-reader.ts';
import { createSqlDashboardRecordReader } from './contexts/analytics/infrastructure/sql-dashboard-record-reader.ts';
import {
  type SituationsService,
  createSituationsService,
} from './contexts/situations/application/index.ts';
import { createSqlProjectSettingsStore } from './contexts/situations/infrastructure/sql-project-settings-store.ts';
import { createSqlSituationRecordReader } from './contexts/situations/infrastructure/sql-situation-record-reader.ts';
import {
  type AutomationService,
  type ChannelSender,
  type PushSender,
  createAutomationService,
} from './contexts/automation/application/index.ts';
import {
  createHttpChannelSender,
  createSqlAutomationStore,
  createSqlPushStore,
  createWebPushSender,
} from './contexts/automation/infrastructure/index.ts';
import {
  type ApiKeyService,
  type IngestService,
  createApiKeyService,
  createIngestService,
} from './contexts/integration/application/index.ts';
import {
  createSqlApiKeyStore,
  createSqlIngestReceipts,
  keyCrypto,
} from './contexts/integration/infrastructure/index.ts';
import { type AuditService, createAuditService } from './contexts/audit/application/index.ts';
import { createSqlAuditReader } from './contexts/audit/infrastructure/sql-audit-reader.ts';
import {
  type DocumentLabService,
  createDocumentLabService,
} from './contexts/documents/application/index.ts';
import {
  createSqlReviewStore,
  documentReader,
  ocrmypdfRecognizer,
  withOcr,
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
  LINK_TYPES,
  createOntologyService,
  type OntologyService,
} from './contexts/ontology/application/index.ts';
import { createSqlEmbeddingIndex } from './contexts/ontology/infrastructure/sql-embedding-index.ts';
import { createSqlOntologyStore } from './contexts/ontology/infrastructure/sql-ontology-store.ts';
import {
  RECORD_MODULES,
  createRecordsService,
  moduleForSlug,
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
  readonly geography: GeographyService;
  readonly authorizedSources: AuthorizedSourcesService;
  readonly media: MediaMonitorService;
  readonly runtime: AutomationRuntime;
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
  readonly situations: SituationsService;
  readonly evidence: EvidenceService;
  readonly documents: DocumentLabService;
  readonly intelligence: IntelligenceService;
  readonly prevention: PreventionService;
  readonly management: ManagementService;
  readonly automation: AutomationService;
  readonly apiKeys: ApiKeyService;
  readonly ingest: IngestService;
  readonly clientIp: ClientIp;
};

const randomHex = (length: number) =>
  randomBytes(Math.ceil(length / 2))
    .toString('hex')
    .slice(0, length);

/** Wires adapters into use cases (manual constructor injection, docs/adr/0002). */
export const buildContainer = async (deps: {
  geographyGateway?: GeographyGateway;
  sourceGateway?: OfficialSourceGateway;
  feedGateway?: FeedGateway;
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
  /** Overrides browser push delivery (tests record pushes instead). */
  pushSender?: PushSender | null;
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
  const recordStore = createSqlRecordStore(deps.sql);
  const records = createRecordsService({
    store: recordStore,
    clock: deps.clock,
    randomHex: (length) => randomHex(length).toUpperCase(),
  });
  const embeddings = deps.embeddings ?? createOllamaEmbeddings(deps.config.ollama);
  const ontology = createOntologyService({
    store: createSqlOntologyStore(deps.sql),
    clock: deps.clock,
    ...(deps.config.semanticSearch
      ? { semantic: { index: createSqlEmbeddingIndex(deps.sql), embedder: embeddings } }
      : {}),
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
      async mentions(tenantId, slug, id) {
        const found = await ontology.mentions(tenantId, slug, id);
        return (
          found?.map((m) => ({
            other: m.other,
            label: LINK_TYPES.find((t) => t.id === m.linkType)?.label ?? m.linkType,
            holder: m.holder,
            field: m.field,
            excerpt: m.excerpt,
            linkType: m.linkType,
            source: m.source,
            target: m.target,
          })) ?? null
        );
      },
    },
    proposals: {
      store: createSqlProposalStore(deps.sql),
      actions: {
        async link(tenantId, link, note, actor) {
          const created = await ontology.link(tenantId, { ...link, note }, actor);
          return created.ok ? 'created' : created.error === 'duplicate' ? 'duplicate' : 'failed';
        },
        async create(tenantId, record) {
          const module = moduleForSlug(record.slug);
          if (!module) return null;
          const created = await records.create(tenantId, module, record.payload);
          return created.ok ? created.value : null;
        },
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

  const recordReader = createSqlAnalyticsRecordReader(deps.sql);
  const analytics = createAnalyticsService({
    reader: recordReader,
    dashboardReader: createSqlDashboardRecordReader(deps.sql),
    clock: deps.clock,
    renderer: docxRenderer,
  });
  const situations = createSituationsService({
    settings: createSqlProjectSettingsStore(deps.sql),
    records: createSqlSituationRecordReader(deps.sql),
    clock: deps.clock,
  });
  const indicators = createIndicatorsService({
    records: createSqlModuleRecordReader(deps.sql),
    configs: createSqlIrsaConfigStore(deps.sql),
    snapshots: createSqlIrsaSnapshotStore(deps.sql),
    clock: deps.clock,
    phaseWeights: { forTenant: situations.phaseWeights },
  });
  const reader = deps.config.ocr
    ? withOcr(documentReader, ocrmypdfRecognizer(deps.config.ocr.languages))
    : documentReader;
  const evidence = createEvidenceService({
    storage: deps.objectStorage ?? createObjectStorage(deps.config.storage),
    store: createSqlAttachmentStore(deps.sql),
    clock: deps.clock,
    randomHex,
    maxUploadBytes: deps.config.maxUploadBytes,
    // The evidence viewer reads text with the same parsers as the document lab.
    text: {
      pdf: async (bytes, maxPages) => {
        const result = await reader.readPdf(bytes, maxPages);
        return result.kind === 'pages' ? result.pages : null;
      },
      docx: async (bytes) => {
        const content = await reader.readDocx(bytes);
        return [
          ...content.paragraphs,
          ...content.tables.flatMap((rows) => rows.map((row) => row.join('\t'))),
        ];
      },
    },
  });
  const documents = createDocumentLabService({
    reader,
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
    embeddings,
    alerts: createSqlAlertStore(deps.sql),
    clock: deps.clock,
    randomHex,
    version4: { enabled: async (scope) => (await situations.settings(scope)).version4 },
  });
  const prevention = createPreventionService({
    store: createSqlActionStore(deps.sql),
    alerts: { status: (scope, id) => intelligence.alertStatus(scope, id) },
    evidence: {
      find: async (scope, attachmentId) => {
        const file = await evidence.get(formatScope(scope), attachmentId);
        return file
          ? { attachmentId: file.id, fileName: file.originalName, sha256: file.sha256 }
          : null;
      },
    },
    version4: { enabled: async (scope) => (await situations.settings(scope)).version4 },
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
  const geography = createGeographyService({
    reader: recordReader,
    gateway: deps.geographyGateway ?? createIngemmetGateway(),
    spatial: createPostgisSpatialEngine(deps.sql),
  });
  /** Narratives from authorized public sources, created once per canonical id. */
  const sourceImporter: SourceImporter = {
    async createOnce(tenantId, id, payload) {
      const created = await recordStore.create(
        tenantId,
        'Narrativas',
        [id],
        () => payload,
        { action: 'CREATE', detail: 'Importación de fuente pública autorizada' },
        deps.clock.now(),
      );
      if (created) return { id: created, created: true };
      const existing = await recordStore.get(tenantId, 'Narrativas', id);
      if (
        existing?.payload.Fuente_Integracion !== payload.Fuente_Integracion ||
        existing?.payload.Fuente_Huella_SHA256 !== payload.Fuente_Huella_SHA256
      )
        throw new Error('source_identity_collision');
      return { id, created: false };
    },
  };
  const authorizedSources = createAuthorizedSourcesService({
    gateway: deps.sourceGateway ?? createOfficialSourceGateway(),
    settings: createSqlSourceSettings(deps.sql),
    clock: deps.clock.now,
    importer: sourceImporter,
  });
  const media = createMediaMonitorService({
    feeds: createSqlMediaFeeds(deps.sql),
    gateway: deps.feedGateway ?? createRssFeedGateway(),
    importer: sourceImporter,
    active: situations.version4,
    clock: deps.clock.now,
  });
  const automation = createAutomationService({
    executionBudgetMs: 8000,
    evaluateNarrative: async (tenantId, event, minimumLevel) => {
      const scope = parseScope(tenantId);
      if (!scope || !event.recordId || !event.record) return { outcome: 'ineligible' };
      return intelligence.evaluateNarrative(scope, {
        id: event.recordId,
        payload: event.record.payload,
        marking: event.record.marking,
        minimumLevel,
      });
    },
    store: createSqlAutomationStore(deps.sql),
    sender: deps.channelSender ?? createHttpChannelSender(),
    sealer: cipher,
    clock: deps.clock,
    recordModules: RECORD_MODULES,
    push: {
      store: createSqlPushStore(deps.sql),
      sender:
        deps.pushSender !== undefined
          ? deps.pushSender
          : deps.config.automation.vapid
            ? createWebPushSender(deps.config.automation.vapid)
            : null,
    },
  });
  const worker = <T>(fn: () => Promise<T>) =>
    runWithRequestContext({ requestId: randomUUID(), actor: 'automation', clearance: 'full' }, fn);
  const runtime = createAutomationRuntime({
    store: createSqlAutomationRuntimeStore(deps.sql),
    clock: deps.clock,
    onError: () => log('error', 'automation_processing_failed', {}),
    beforeTick: async (tenantId, source) => {
      if (source !== 'cron') return;
      // Media feeds are polled even when the Defensoría connector fails, and vice versa.
      const [official, feeds] = await Promise.allSettled([
        worker(() => authorizedSources.poll(tenantId)),
        worker(() => media.poll(tenantId)),
      ]);
      for (const outcome of [official, feeds])
        if (outcome.status === 'rejected') throw outcome.reason;
    },
    tick: (tenantId) => worker(() => automation.tick(tenantId)),
  });
  return {
    geography,
    authorizedSources,
    media,
    runtime,
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
    situations,
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
    ingest: createIngestService({
      records,
      receipts: createSqlIngestReceipts(deps.sql),
      clock: deps.clock,
    }),
    clientIp: deps.clientIp,
  };
};
