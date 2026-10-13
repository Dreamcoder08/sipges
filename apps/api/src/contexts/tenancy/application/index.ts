// Public API of the Tenancy context (docs/adr/0002).
export { DEFAULT_SCOPE, type Scope, formatScope, parseScope } from '../domain/scope.ts';
export type { TenantSummary, UserDirectory } from './ports.ts';
export { createTenancyService, type TenancyService } from './tenancy-service.ts';
