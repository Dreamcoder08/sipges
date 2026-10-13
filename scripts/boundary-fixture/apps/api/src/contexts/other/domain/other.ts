// Deliberate violation: reaching into another context's domain (contexts-are-isolated).
import { entity } from '../../sample/domain/entity.ts';

export const other = entity;
