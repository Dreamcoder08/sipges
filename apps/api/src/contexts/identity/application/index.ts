// Public API of the Identity & Access context (docs/adr/0002).
export type { Identity, Role, SessionIdentity } from '../domain/user.ts';
export type { AccessDecision } from '../domain/access-policy.ts';
export {
  SESSION_SECONDS,
  createIdentityService,
  type IdentityService,
  type LoginError,
} from './identity-service.ts';
export type { Clock, SecretCipher } from './ports.ts';
