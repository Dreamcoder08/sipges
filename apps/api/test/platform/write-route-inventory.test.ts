import { describe, expect, it } from 'vitest';
import { NOT_IMPORTABLE, RECORD_MODULES, WRITE_ROUTES } from '../../../parity/src/write-routes.ts';
import { RECORD_MODULES as SOURCE_MODULES } from '../../src/contexts/records/domain/modules.ts';
import { isImportable } from '../../src/contexts/records/domain/import.ts';
import { createTestApp } from '../support/test-app.ts';

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const inventory = () => WRITE_ROUTES.map((r) => `${r.method} ${r.path}`).sort();

/** The router's write routes, with each record route written once per module. */
const routerWrites = async () => {
  const { app } = await createTestApp();
  const expand = (route: string) =>
    /\/(api|system\/import)\/:module/.test(route)
      ? SOURCE_MODULES.filter(
          ({ slug, module }) =>
            !route.includes('/system/import/') || (isImportable(module) && slug),
        ).map(({ slug }) => route.replace(':module', slug))
      : [route];
  const routes = app.routes
    .filter((r) => WRITES.has(r.method))
    .flatMap((r) => expand(`${r.method} ${r.path}`));
  return [...new Set(routes)].sort();
};

describe('write route inventory of the parity write proof', () => {
  it('lists every write route of the router, and only those', async () => {
    expect(inventory()).toEqual(await routerWrites());
  });

  it('lists the record modules of the source', () => {
    expect(RECORD_MODULES.map((m) => ({ ...m }))).toEqual(SOURCE_MODULES.map((m) => ({ ...m })));
  });

  it('names exactly the modules the router refuses to import', () => {
    expect([...NOT_IMPORTABLE].sort()).toEqual(
      SOURCE_MODULES.filter(({ module }) => !isImportable(module))
        .map(({ slug }) => slug)
        .sort(),
    );
  });

  it('gives a reason for every route that is excused from writing a row', () => {
    const silent = WRITE_ROUTES.filter((r) => r.rows === 'none' && !r.why && !r.blocked);
    expect(silent).toEqual([]);
  });
});
