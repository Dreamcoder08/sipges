import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CASES } from '../../parity/src/cases.ts';
import { GO_ROUTES, type GoRoute, validateGoRoutes } from '../src/go-routes.ts';

/**
 * docs/deployment/go-activation-reads.md proposes the routes of the Inicio and Registros screens
 * for GO_ROUTES (T48). The proposal is prose until someone acts on it, so these tests hold the
 * doc to what the Worker would accept the day it is copied in, and to the URLs the browser sends.
 */
const doc = () =>
  readFile(
    new URL('../../../docs/deployment/go-activation-reads.md', import.meta.url),
    'utf8',
  ).catch(() => '');

const block = (text: string, info: string) =>
  [...text.matchAll(new RegExp(`^\`\`\`text ${info}\\n([\\s\\S]*?)^\`\`\`$`, 'gm'))]
    .flatMap((match) => (match[1] ?? '').split('\n'))
    .filter(Boolean);

const proposed = async (): Promise<GoRoute[]> =>
  block(await doc(), 'go-routes').map((line) => {
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

  it('has a parity case for every URL the browser sends, scope header included', async () => {
    const urls = block(await doc(), 'first-paint');
    expect(urls.length).toBeGreaterThan(0);
    const uncovered = urls.filter(
      (url) => !CASES.some((c) => c.method === 'GET' && c.path === url && c.headers?.[SCOPE]),
    );
    expect(uncovered).toEqual([]);
  });
});
