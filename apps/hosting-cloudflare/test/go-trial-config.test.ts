import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { renderGoConfig } from '../src/go-trial-config.ts';

const PRODUCTION = 'a'.repeat(32);
const TRIAL = 'b'.repeat(32);
const go = `// a comment
{
  "name": "sipges-go",
  "vars": { "SIPGES_GO_ROUTING": "1", },
}
`;
const production = `{ "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "${PRODUCTION}" }], }`;

describe('Go trial config', () => {
  it('adds the Hyperdrive of the trial, set at deploy, to the Go config', () => {
    expect(JSON.parse(renderGoConfig(go, production, TRIAL))).toEqual({
      name: 'sipges-go',
      vars: { SIPGES_GO_ROUTING: '1' },
      hyperdrive: [{ binding: 'HYPERDRIVE', id: TRIAL }],
    });
  });

  it('refuses the production Hyperdrive', () => {
    expect(() => renderGoConfig(go, production, PRODUCTION)).toThrow(/production/);
  });

  it('refuses the all-zero placeholder', () => {
    expect(() => renderGoConfig(go, production, '0'.repeat(32))).toThrow(/placeholder/);
  });

  it.each([undefined, '', 'nothex', 'A'.repeat(32), `${TRIAL}0`])(
    'refuses %s, which is no Hyperdrive id',
    (id) => {
      expect(() => renderGoConfig(go, production, id)).toThrow(/SIPGES_GO_HYPERDRIVE_ID/);
    },
  );

  it('reads the real files: the id of production is refused and nothing else changes', async () => {
    const read = (name: string) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
    const [goText, productionText] = await Promise.all([
      read('wrangler.go.jsonc'),
      read('wrangler.jsonc'),
    ]);
    const id = /"hyperdrive":\s*\[\{[^}]*"id":\s*"([0-9a-f]{32})"/.exec(productionText)?.[1];
    expect(() => renderGoConfig(goText, productionText, id)).toThrow(/production/);
    const rendered = JSON.parse(renderGoConfig(goText, productionText, TRIAL)) as {
      name: string;
      hyperdrive: unknown;
      containers: unknown[];
    };
    expect(rendered.name).toBe('sipges-go');
    expect(rendered.hyperdrive).toEqual([{ binding: 'HYPERDRIVE', id: TRIAL }]);
    expect(rendered.containers).toHaveLength(1);
  });
});
