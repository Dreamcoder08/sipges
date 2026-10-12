import type { HealthResponse } from '@mascli/contracts';
import { Hono } from 'hono';

const HEALTH: HealthResponse = { status: 'ok', service: 'MASCLI', version: 'V0.5.1' };

export const healthRoutes = () => new Hono().get('/health', (c) => c.json(HEALTH));
