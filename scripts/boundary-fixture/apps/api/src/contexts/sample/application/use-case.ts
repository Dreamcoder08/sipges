// Deliberate violation: use case importing an adapter (application-does-not-reach-outward).
import { repository } from '../infrastructure/repository.ts';

export const useCase = repository;
