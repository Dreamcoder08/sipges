import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { fileReferenceReader } from '../../src/contexts/reference/infrastructure/file-reference-reader.ts';
import { staticReferenceReader } from '../../src/contexts/reference/infrastructure/static-reference-reader.ts';

const json = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(`../../../../data/${name}`, import.meta.url), 'utf8'));

it('serves the bundled references exactly like the file reader, without a filesystem', async () => {
  const reader = staticReferenceReader({
    coordinates: await json('project_coordinates.json'),
    entities: await json('canonical_entities.json'),
  });
  const registered = { companyId: 'MASCLI', projectId: 'PRJ-SECHURA' };
  expect(await reader.coordinates(registered)).toEqual(
    await fileReferenceReader.coordinates(registered),
  );
  expect(await reader.entities(registered)).toEqual(await fileReferenceReader.entities(registered));
});

it('keeps the references registered to their one tenant', async () => {
  const reader = staticReferenceReader({
    coordinates: await json('project_coordinates.json'),
    entities: await json('canonical_entities.json'),
  });
  for (const scope of [
    { companyId: 'OTHER', projectId: 'PRJ-SECHURA' },
    { companyId: 'MASCLI', projectId: 'OTHER' },
  ]) {
    expect(await reader.coordinates(scope)).toBeNull();
    expect(await reader.entities(scope)).toBeNull();
  }
});

it('rejects bundled data that does not match the reference contracts', async () => {
  const reader = staticReferenceReader({ coordinates: { wrong: true }, entities: [] });
  const registered = { companyId: 'MASCLI', projectId: 'PRJ-SECHURA' };
  await expect(reader.coordinates(registered)).rejects.toThrow();
  await expect(reader.entities(registered)).rejects.toThrow();
});
