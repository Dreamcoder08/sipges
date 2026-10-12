// Deliberate violations: cross-feature import and web importing the API.
import { beta } from '../beta/beta.ts';
import { useCase } from '../../../../api/src/contexts/sample/application/use-case.ts';

export const alpha = [beta, useCase];
