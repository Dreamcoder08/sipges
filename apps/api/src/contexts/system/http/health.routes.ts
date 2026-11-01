import type { HealthResponse } from '@sipges/contracts';
import { Hono } from 'hono';

const HEALTH: HealthResponse = { status: 'ok', service: 'SIPGES', version: 'V0.5.1' };

export const healthRoutes = () => new Hono().get('/health', (c) => c.json(HEALTH));
