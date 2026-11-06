import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CASES } from '../../parity/src/cases.ts';
import { GO_ROUTES, type GoRoute, validateGoRoutes } from '../src/go-routes.ts';

/**
 * docs/deployment/go-activation-reads.md proposes the routes of the Inicio and Registros screens
 * for GO_ROUTES (T48). The proposal is prose until someone acts on it, so these tests hold the
 * doc to what the Worker would accept the day it is copied in. Its first-paint URLs are copied by
 * hand from apps/web: these tests do not read the web code.
 */
const doc = () =>
  readFile(new URL('../../../docs/deployment/go-activation-reads.md', import.meta.url), 'utf8');

const block = (text: string, info: string) =>
  [...text.matchAll(new RegExp(`^\`\`\`text ${info}\\n([\\s\\S]*?)^\`\`\`$`, 'gm'))]
    .flatMap((match) => (match[1] ?? '').split('\n'))
    .filter(Boolean);

const proposed = async (): Promise<GoRoute[]> =>
  block(await doc(), 'go-routes').map((line) => {
    const [method, path] = line.split(' ');
    return { method, path } as GoRoute;
  });

const proposedWrites = async (): Promise<GoRoute[]> =>
  block(await doc(), 'go-writes').map((line) => {
    const [method, path] = line.split(' ');
    return { method, path } as GoRoute;
  });

const SCOPE = 'X-SIPGES-Scope';

describe('Proposed Go routes for Inicio and Registros', () => {
  it('keeps GO_ROUTES empty in code: T48 prepares the switch, it does not perform it', () => {
    expect(GO_ROUTES).toEqual([]);
  });

  it('would pass the Worker check as it stands, one parity case per route', async () => {
    const routes = await proposed();
    expect(routes.length).toBeGreaterThan(0);
    expect(validateGoRoutes(routes, CASES)).toEqual([]);
  });

  it('lists exact paths: reads only, and no pattern that would catch another module', async () => {
    for (const { method, path } of await proposed()) {
      expect(method).toBe('GET');
      expect(path).not.toMatch(/^\/api\/:/);
      expect(path).not.toMatch(/:(?!id(\/|$))/);
    }
  });

  it('never proposes the routes that must stay on TypeScript', async () => {
    const paths = (await proposed()).map((route) => route.path);
    expect(paths).not.toContain('/system/events');
    expect(paths).not.toContain('/system/auth/providers');
    expect(paths.filter((path) => /\/(preview|download)$/.test(path))).toEqual([]);
  });

  it('has a parity case for every URL the document lists, scope header included', async () => {
    const urls = block(await doc(), 'first-paint');
    expect(urls.length).toBeGreaterThan(0);
    const uncovered = urls.filter(
      (url) => !CASES.some((c) => c.method === 'GET' && c.path === url && c.headers?.[SCOPE]),
    );
    expect(uncovered).toEqual([]);
  });

  it('proposes the other ported reads in Wave D', async () => {
    const paths = (await proposed()).map((route) => route.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/system/indicators',
        '/system/irsa/history',
        '/system/prevention/summary',
        '/system/conflict-risk',
        '/system/intelligence/territorial-alerts/:id',
      ]),
    );
  });

  it('leaves out the reads that need settings the container does not get', async () => {
    const paths = (await proposed()).map((route) => route.path);
    for (const path of ['/system/search', '/system/notifications/push', '/system/metrics'])
      expect(paths).not.toContain(path);
  });

  it('lists the ported writes apart, each with a parity case and no read among them', async () => {
    const writes = await proposedWrites();
    expect(writes.length).toBeGreaterThan(0);
    expect(validateGoRoutes(writes, CASES)).toEqual([]);
    expect(writes.filter(({ method }) => method === 'GET')).toEqual([]);
    for (const { path } of writes) expect(path).not.toMatch(/^\/api\/:/);
    expect(writes).toContainEqual({ method: 'POST', path: '/api/eventos' });
    expect(writes).toContainEqual({ method: 'POST', path: '/system/uploads' });
  });
});
