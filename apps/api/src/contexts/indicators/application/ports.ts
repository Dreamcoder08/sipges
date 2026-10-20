import type { IrsaConfig, ModuleRecords } from '../domain/index.ts';

/** Read side of the tenant's module records (owned by Territorial Records, T6). */
export type ModuleRecordReader = {
  /** Every record of the given modules, payload plus `_id`; empty when none exist yet. */
  read(tenantId: string): Promise<ModuleRecords>;
};

/** Per-tenant IRSA configuration; null means the tenant still uses the defaults. */
export type IrsaConfigStore = {
  load(tenantId: string): Promise<IrsaConfig | null>;
  /** Saves the configuration and its audit entry atomically. */
  save(tenantId: string, config: IrsaConfig, at: Date, auditDetail: string): Promise<void>;
};

export type NewIrsaSnapshot = {
  readonly ts: Date;
  readonly irsa: number;
  readonly level: string;
  readonly scores: Readonly<Record<string, number>>;
  readonly configVersion: string;
  readonly note: string;
  readonly auditDetail: string;
};

/** app.py irsa_snapshots row, as GET /system/irsa/history returns it. */
export type IrsaSnapshot = {
  readonly id: number;
  readonly ts: string;
  readonly irsa: number;
  readonly level: string;
  readonly scores: Record<string, number>;
  readonly config_version: string | null;
  readonly note: string | null;
};

export type IrsaSnapshotStore = {
  /** Saves the snapshot and its audit entry atomically; returns the new snapshot id. */
  insert(tenantId: string, snapshot: NewIrsaSnapshot): Promise<number>;
  /** Newest first; `limit` null means every snapshot. */
  list(tenantId: string, limit: number | null): Promise<IrsaSnapshot[]>;
};

export type Clock = { now(): Date };

/** Weights of the project's current phase (MASCLI 4.0, docs/adr/0021 §4); null keeps the general ones. */
export type PhaseWeightsSource = {
  forTenant(tenantId: string): Promise<{
    readonly phase: string;
    readonly label: string;
    readonly weights: Readonly<Record<string, number>>;
  } | null>;
};
