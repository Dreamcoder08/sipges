// Deliberate cycle with domain/entity.ts (no-circular).
import { entity } from '../domain/entity.ts';

export const repository = 'fixture';
export const echo = () => entity;
