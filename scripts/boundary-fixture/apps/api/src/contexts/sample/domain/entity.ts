// Deliberate violation: domain importing infrastructure. Used by scripts/check-boundaries.mjs.
import { repository } from '../infrastructure/repository.ts';

export const entity = repository;
