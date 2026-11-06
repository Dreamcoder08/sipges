import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

/**
 * Hyperdrive caches reads outside transactions, which covers accounts, sessions and grants; a
 * cached read could keep a revoked session alive. Every deploy must re-assert caching off.
 */
describe('Workers deploy script', () => {
  it('turns Hyperdrive query caching off for the bound config before deploying', async () => {
    const config = await read('../wrangler.jsonc');
    const id = /"hyperdrive":\s*\[\{[^}]*"id":\s*"([0-9a-f]{32})"/.exec(config)?.[1];
    expect(id).toBeDefined();
    const { scripts } = JSON.parse(await read('../package.json')) as {
      scripts: Record<string, string>;
    };
    expect(scripts['deploy:worker']).toBe(
      `wrangler hyperdrive update ${id} --caching-disabled true && wrangler deploy`,
    );
  });
});

/** Only `deploy:worker` builds the Go image; a local bundle or `wrangler dev` needs no Docker. */
describe('Go container locally', () => {
  it('leaves containers out of `wrangler dev` and the dry-run bundle', async () => {
    expect(await read('../wrangler.jsonc')).toMatch(/"dev":\s*\{\s*"enable_containers":\s*false/);
    const { scripts } = JSON.parse(await read('../package.json')) as {
      scripts: Record<string, string>;
    };
    expect(scripts.bundle).toContain('--containers-rollout=none');
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

  it('builds the Go image on a GitHub-hosted runner, with buildx set up before the deploy', async () => {
    const text = await workflow();
    expect(text).toContain('runs-on: ubuntu-latest');
    expect(text).not.toContain('SIPGES_RUNS_ON');
    const buildx = text.indexOf('uses: docker/setup-buildx-action@');
    expect(buildx).toBeGreaterThanOrEqual(0);
    expect(buildx).toBeLessThan(text.indexOf('- name: Deploy the Worker'));
  });

  it('smoke-tests /health/ready, which runs SELECT 1, after deploying', async () => {
    const smoke = step(await workflow(), 'Smoke test /health/ready');
    expect(smoke).toContain('id: smoke');
    expect(smoke).toMatch(/curl -fsS[^\n]*\/health\/ready/);
  });

  it('probes a Go route after /health/ready, which only ever reaches TypeScript', async () => {
    const text = await workflow();
    const smoke = step(text, 'Smoke test a Go route');
    expect(smoke).toContain('id: smoke_go');
    expect(smoke).toContain('node apps/hosting-cloudflare/smoke-go.mjs');
    expect(smoke).toContain('SIPGES_SMOKE_URL: https://sipges.dreamcoder-dev08.workers.dev');
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
