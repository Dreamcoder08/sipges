import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

const OWNER_HOST = 'sipges.dreamcoder-dev08.workers.dev';
const OWNER_HYPERDRIVE = '9eae2c5e3d614feca42b525fc82e10e1';
const SCRIPT = fileURLToPath(new URL('../deploy-config.mjs', import.meta.url));

/** Environment of a deploy job: only what the test passes, never the developer's own. */
const run = (args: string[], env: Record<string, string>) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
  });

const withTempDir = async <T>(use: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), 'sipges-deploy-config-'));
  try {
    return await use(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** S4: the Worker configuration the owner's production deploy published before it became a template. */
const OWNER_CONFIG_BEFORE = {
  $schema: './node_modules/wrangler/config-schema.json',
  name: 'sipges',
  main: 'src/index.ts',
  compatibility_date: '2026-10-20',
  compatibility_flags: ['nodejs_compat'],
  alias: { '@node-rs/argon2': './src/native-argon2-unavailable.ts' },
  rules: [{ type: 'Text', globs: ['**/*.sql'], fallthrough: false }],
  assets: {
    directory: './public',
    binding: 'ASSETS',
    run_worker_first: true,
    html_handling: 'none',
    not_found_handling: 'none',
  },
  hyperdrive: [{ binding: 'HYPERDRIVE', id: OWNER_HYPERDRIVE }],
  r2_buckets: [{ binding: 'EVIDENCE', bucket_name: 'sipges-evidence' }],
  triggers: { crons: ['*/15 * * * *'] },
  vars: { SIPGES_ALLOWED_HOSTS: OWNER_HOST },
  limits: { cpu_ms: 30000 },
  observability: { enabled: true },
};

describe('Deploy config from repository variables', () => {
  it("S4: renders from the owner's variables the config that was committed before", async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'wrangler.deploy.jsonc');
      const result = run(['--out', out], {
        SIPGES_PUBLIC_HOST: OWNER_HOST,
        SIPGES_HYPERDRIVE_ID: OWNER_HYPERDRIVE,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(await readFile(out, 'utf8'))).toEqual(OWNER_CONFIG_BEFORE);
    });
  });

  it("S4: another owner's variables change only the host and the Hyperdrive id", async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'wrangler.deploy.jsonc');
      const result = run(['--out', out], {
        SIPGES_PUBLIC_HOST: 'sipges.example.org',
        SIPGES_HYPERDRIVE_ID: 'c'.repeat(32),
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(await readFile(out, 'utf8'))).toEqual({
        ...OWNER_CONFIG_BEFORE,
        hyperdrive: [{ binding: 'HYPERDRIVE', id: 'c'.repeat(32) }],
        vars: { SIPGES_ALLOWED_HOSTS: 'sipges.example.org' },
      });
    });
  });

  it.each([
    ['SIPGES_PUBLIC_HOST', { SIPGES_HYPERDRIVE_ID: OWNER_HYPERDRIVE }],
    ['SIPGES_PUBLIC_HOST', { SIPGES_PUBLIC_HOST: '  ', SIPGES_HYPERDRIVE_ID: OWNER_HYPERDRIVE }],
    ['SIPGES_HYPERDRIVE_ID', { SIPGES_PUBLIC_HOST: OWNER_HOST }],
    ['SIPGES_HYPERDRIVE_ID', { SIPGES_PUBLIC_HOST: OWNER_HOST, SIPGES_HYPERDRIVE_ID: '' }],
  ])('S3: stops with the exact message when %s is missing', async (name, env) => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'wrangler.deploy.jsonc');
      for (const args of [['--check'], ['--out', out]]) {
        const result = run(args, env);
        expect(result.status).toBe(1);
        expect(result.stderr).toBe(
          `Missing GitHub Actions variable ${name}: see docs/deployment/own-instance.md\n`,
        );
        expect(result.stdout).toBe('');
      }
      await expect(readFile(out, 'utf8')).rejects.toThrow(/ENOENT/);
    });
  });

  it('S3: reports the first missing variable, and --check writes nothing when both are set', async () => {
    const both = run(['--check'], {});
    expect(both.stderr).toContain('SIPGES_PUBLIC_HOST');
    expect(both.stderr).not.toContain('SIPGES_HYPERDRIVE_ID');
    const ok = run(['--check'], {
      SIPGES_PUBLIC_HOST: OWNER_HOST,
      SIPGES_HYPERDRIVE_ID: OWNER_HYPERDRIVE,
    });
    expect(ok.status).toBe(0);
    expect(ok.stderr).toBe('');
  });

  it.each([
    ['SIPGES_PUBLIC_HOST', ` ${OWNER_HOST}`],
    ['SIPGES_PUBLIC_HOST', `${OWNER_HOST}\n`],
    ['SIPGES_HYPERDRIVE_ID', ` ${OWNER_HYPERDRIVE}`],
    ['SIPGES_HYPERDRIVE_ID', `${OWNER_HYPERDRIVE}\n`],
    ['SIPGES_HYPERDRIVE_ID', '0'.repeat(32)],
    ['SIPGES_PUBLIC_HOST', 'https://sipges.example.org'],
    ['SIPGES_PUBLIC_HOST', 'sipges.example.org/path'],
    ['SIPGES_HYPERDRIVE_ID', 'not-an-id'],
    ['SIPGES_HYPERDRIVE_ID', 'A'.repeat(32)],
  ])('refuses a malformed %s without echoing it', (name, value) => {
    const env = {
      SIPGES_PUBLIC_HOST: OWNER_HOST,
      SIPGES_HYPERDRIVE_ID: OWNER_HYPERDRIVE,
      [name]: value,
    };
    const result = run(['--check'], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(name);
    expect(result.stderr).not.toContain(value);
  });
});

/** S2: a fork must not inherit anyone's account; these files are what a fork deploys. */
describe('Deploy config usage', () => {
  it.each([['--out'], ['--check', '--out'], ['--out', '--check']])(
    'gives a usage error for %j, without a raw Node error',
    (...args) => {
      const result = run(args, {
        SIPGES_PUBLIC_HOST: OWNER_HOST,
        SIPGES_HYPERDRIVE_ID: OWNER_HYPERDRIVE,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Usage: node deploy-config.mjs [--check] [--out <file>]');
      expect(result.stderr).not.toContain('ERR_INVALID_ARG_TYPE');
    },
  );
});

describe('Rendered config read by wrangler itself', () => {
  it("S4: unstable_readConfig sees the owner's Hyperdrive id, host and the rest unchanged", async () => {
    const { unstable_readConfig: readConfig } = await import('wrangler');
    await withTempDir(async (dir) => {
      const out = join(dir, 'wrangler.deploy.jsonc');
      const result = run(['--out', out], {
        SIPGES_PUBLIC_HOST: OWNER_HOST,
        SIPGES_HYPERDRIVE_ID: OWNER_HYPERDRIVE,
      });
      expect(result.status, result.stderr).toBe(0);
      const config = readConfig({ config: out });
      expect(config.name).toBe('sipges');
      expect(config.hyperdrive).toEqual([{ binding: 'HYPERDRIVE', id: OWNER_HYPERDRIVE }]);
      expect(config.vars).toEqual({ SIPGES_ALLOWED_HOSTS: OWNER_HOST });
      expect(config.triggers.crons).toEqual(['*/15 * * * *']);
      expect(config.r2_buckets).toEqual([
        expect.objectContaining({ binding: 'EVIDENCE', bucket_name: 'sipges-evidence' }),
      ]);
      expect(config.compatibility_date).toBe('2026-10-20');
    });
  });
});

describe('Deployable files carry no account value', () => {
  it.each([
    '../wrangler.jsonc',
    '../wrangler.go.jsonc',
    '../package.json',
    '../../../.github/workflows/deploy-workers.yml',
  ])("%s holds neither the owner's Hyperdrive id nor workers.dev host", async (path) => {
    const text = await read(path);
    expect(text).not.toContain(OWNER_HYPERDRIVE);
    expect(text).not.toContain('dreamcoder-dev08');
  });

  it('S2: deploys through the rendered config and the variable, and keeps caching off', async () => {
    const { scripts } = JSON.parse(await read('../package.json')) as {
      scripts: Record<string, string>;
    };
    expect(scripts['deploy:worker']).toBe(
      'node deploy-config.mjs && wrangler hyperdrive update "$SIPGES_HYPERDRIVE_ID" --caching-disabled true && wrangler deploy -c wrangler.deploy.jsonc',
    );
  });

  it('keeps the rendered config out of git', async () => {
    expect(await read('../../../.gitignore')).toMatch(
      /^apps\/hosting-cloudflare\/wrangler\.deploy\.jsonc$/m,
    );
  });
});

/** A failed deploy must not stay live: the smoke test proves the database answers. */
describe('Deploy Workers workflow', () => {
  const workflow = () => read('../../../.github/workflows/deploy-workers.yml');
  /** The text of one step, from its `- name:` line to the next step. */
  const step = (text: string, name: string) => {
    const start = text.indexOf(`- name: ${name}`);
    expect(start, name).toBeGreaterThanOrEqual(0);
    const next = text.indexOf('\n      - ', start + 1);
    return text.slice(start, next === -1 ? undefined : next);
  };

  it('smoke-tests /health/ready, which runs SELECT 1, after deploying', async () => {
    const smoke = step(await workflow(), 'Smoke test /health/ready');
    expect(smoke).toContain('id: smoke');
    expect(smoke).toMatch(/curl -fsS[^\n]*\/health\/ready/);
    expect(smoke).toContain('https://${SIPGES_PUBLIC_HOST}/health/ready');
  });

  it('S3: checks the variables before installing or building, and passes them to the deploy', async () => {
    const text = await workflow();
    const check = step(text, 'Check deploy variables');
    expect(check).toContain('run: node apps/hosting-cloudflare/deploy-config.mjs --check');
    expect(text.indexOf('Check deploy variables')).toBeLessThan(text.indexOf('pnpm install'));
    expect(text.indexOf('Check deploy variables')).toBeLessThan(
      text.indexOf('@sipges/hosting-cloudflare build'),
    );
    expect(text).toContain('SIPGES_PUBLIC_HOST: ${{ vars.SIPGES_PUBLIC_HOST }}');
    expect(text).toContain('SIPGES_HYPERDRIVE_ID: ${{ vars.SIPGES_HYPERDRIVE_ID }}');
  });

  it('probes a Go route after /health/ready, which only ever reaches TypeScript', async () => {
    const text = await workflow();
    const smoke = step(text, 'Smoke test a Go route');
    expect(smoke).toContain('id: smoke_go');
    expect(smoke).toContain('node apps/hosting-cloudflare/smoke-go.mjs');
    expect(smoke).toContain('SIPGES_SMOKE_URL: https://${{ vars.SIPGES_PUBLIC_HOST }}');
    expect(text.indexOf('Smoke test a Go route')).toBeGreaterThan(
      text.indexOf('Smoke test /health/ready'),
    );
    expect(text.indexOf('Smoke test a Go route')).toBeLessThan(
      text.indexOf('Roll back the Worker'),
    );
  });

  it('rolls back to the previous version when the smoke test fails, then fails the job', async () => {
    const text = await workflow();
    const rollback = step(text, 'Roll back the Worker');
    expect(rollback).toContain(
      "if: failure() && (steps.smoke.outcome == 'failure' || steps.smoke_go.outcome == 'failure')",
    );
    expect(rollback).toMatch(/wrangler rollback --yes --message /);
    expect(rollback).toMatch(/exit 1\s*$/);
    expect(text.indexOf('Roll back the Worker')).toBeGreaterThan(
      text.indexOf('Smoke test /health/ready'),
    );
  });
});
