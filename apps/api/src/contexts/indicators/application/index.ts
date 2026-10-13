// Public API of the Indicators & IRSA context (docs/adr/0002).
export type {
  Clock,
  IrsaConfigStore,
  IrsaSnapshot,
  IrsaSnapshotStore,
  ModuleRecordReader,
  NewIrsaSnapshot,
} from './ports.ts';
export {
  createIndicatorsService,
  type IndicatorsService,
  type ValidationTemplate,
} from './indicators-service.ts';
