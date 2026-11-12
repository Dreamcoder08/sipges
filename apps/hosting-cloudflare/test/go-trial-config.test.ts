import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    const [goText, committedProduction] = await Promise.all([
      read('wrangler.go.jsonc'),
      read('wrangler.jsonc'),
    ]);
    const parse = (text: string) =>
      JSON.parse(text.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1')) as {
        hyperdrive: { id: string }[];
      };
    // The committed file holds a placeholder id; the deploy renders the owner's in its place.
    const id = parse(committedProduction).hyperdrive[0]?.id;
    expect(id).toBe('0'.repeat(32));
    const productionText = committedProduction.replace(id as string, PRODUCTION);
    expect(() => renderGoConfig(goText, productionText, PRODUCTION)).toThrow(
      /production Hyperdrive/,
    );
    expect(JSON.parse(renderGoConfig(goText, productionText, TRIAL))).toEqual({
      ...parse(goText),
      hyperdrive: [{ binding: 'HYPERDRIVE', id: TRIAL }],
    });
  });
});

/** S2: the Go trial Worker's public host is a variable of whoever deploys it, like production's. */
describe('Go trial config command', () => {
  const SCRIPT = fileURLToPath(new URL('../go-trial-config.mjs', import.meta.url));
  const run = (env: Record<string, string>, out: string) =>
    spawnSync(process.execPath, [SCRIPT, '--out', out], {
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
    });
  const withOut = async <T>(use: (out: string) => Promise<T>): Promise<T> => {
    const dir = await mkdtemp(join(tmpdir(), 'sipges-go-config-'));
    try {
      return await use(join(dir, 'wrangler.go.deploy.jsonc'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  it('writes the host from SIPGES_GO_PUBLIC_HOST and the trial Hyperdrive', async () => {
    await withOut(async (out) => {
      const result = run(
        {
          SIPGES_GO_HYPERDRIVE_ID: TRIAL,
          SIPGES_HYPERDRIVE_ID: PRODUCTION,
          SIPGES_GO_PUBLIC_HOST: 'sipges-go.example.org',
        },
        out,
      );
      expect(result.status, result.stderr).toBe(0);
      const config = JSON.parse(await readFile(out, 'utf8')) as {
        name: string;
        vars: Record<string, string>;
        hyperdrive: unknown;
      };
      expect(config.name).toBe('sipges-go');
      expect(config.vars).toEqual({
        SIPGES_ALLOWED_HOSTS: 'sipges-go.example.org',
        SIPGES_GO_ROUTING: '1',
      });
      expect(config.hyperdrive).toEqual([{ binding: 'HYPERDRIVE', id: TRIAL }]);
    });
  });

  it('refuses the production Hyperdrive when SIPGES_HYPERDRIVE_ID names it', async () => {
    await withOut(async (out) => {
      const result = run(
        {
          SIPGES_GO_HYPERDRIVE_ID: PRODUCTION,
          SIPGES_HYPERDRIVE_ID: PRODUCTION,
          SIPGES_GO_PUBLIC_HOST: 'sipges-go.example.org',
        },
        out,
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/production Hyperdrive/);
      await expect(readFile(out, 'utf8')).rejects.toThrow(/ENOENT/);
    });
  });

  it.each([undefined, '', '  ', 'nothex', '0'.repeat(32)])(
    'refuses to run when SIPGES_HYPERDRIVE_ID is %j: the production guard needs it',
    async (id) => {
      await withOut(async (out) => {
        const result = run(
          {
            SIPGES_GO_HYPERDRIVE_ID: TRIAL,
            SIPGES_GO_PUBLIC_HOST: 'sipges-go.example.org',
            ...(id === undefined ? {} : { SIPGES_HYPERDRIVE_ID: id }),
          },
          out,
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('SIPGES_HYPERDRIVE_ID');
        expect(result.stdout).toBe('');
        await expect(readFile(out, 'utf8')).rejects.toThrow(/ENOENT/);
      });
    },
  );

  it('refuses the all-zero placeholder as the trial Hyperdrive', async () => {
    await withOut(async (out) => {
      const result = run(
        {
          SIPGES_GO_HYPERDRIVE_ID: '0'.repeat(32),
          SIPGES_HYPERDRIVE_ID: PRODUCTION,
          SIPGES_GO_PUBLIC_HOST: 'sipges-go.example.org',
        },
        out,
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/placeholder/);
      await expect(readFile(out, 'utf8')).rejects.toThrow(/ENOENT/);
    });
  });

  it('gives a usage error when --out has no path', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--out'], {
      env: { PATH: process.env.PATH ?? '' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: node go-trial-config.mjs [--out <file>]');
  });

  it.each(['', 'https://sipges-go.example.org'])(
    'stops without writing when SIPGES_GO_PUBLIC_HOST is %j',
    async (host) => {
      await withOut(async (out) => {
        const result = run(
          {
            SIPGES_GO_HYPERDRIVE_ID: TRIAL,
            SIPGES_HYPERDRIVE_ID: PRODUCTION,
            SIPGES_GO_PUBLIC_HOST: host,
          },
          out,
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('SIPGES_GO_PUBLIC_HOST');
        await expect(readFile(out, 'utf8')).rejects.toThrow(/ENOENT/);
      });
    },
  );
});
