// Public API of the Management Reporting context (docs/adr/0002).
export type { ActionRow, AlertRow } from '../domain/index.ts';
export { MANAGEMENT_CSV_FILENAME } from '../domain/index.ts';
export type { ManagementSources } from './ports.ts';
export { createManagementService, type ManagementService } from './management-service.ts';
