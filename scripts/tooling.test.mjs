import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
const root = process.cwd();
test('API app-local Vitest registers shared cleanup hooks in the active runner', () => {
  const result = spawnSync('./node_modules/.bin/vitest', ['run', 'test/config.test.ts'], {
    cwd: path.join(root, 'apps/api'),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', NO_COLOR: '1' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Test Files\s+1 passed \(1\)/);
  assert.match(result.stdout, /Tests\s+36 passed \(36\)/);
  assert.doesNotMatch(result.stdout + result.stderr, /Vitest failed to find/);
});
test('web app-local Vitest registers setup hooks in the active runner', () => {
  const result = spawnSync('./node_modules/.bin/vitest', ['run', 'src/app/navigation.test.ts'], {
    cwd: path.join(root, 'apps/web'),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', NO_COLOR: '1' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Test Files\s+1 passed \(1\)/);
  assert.match(result.stdout, /Tests\s+[1-9]\d* passed/);
  assert.doesNotMatch(result.stdout + result.stderr, /Vitest failed to find|no tests|\d+ skipped/);
});
const fixture = (run) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sipges-tooling-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const sipgesSkills = [
  'sipges-adr',
  'sipges-archify',
  'sipges-ci-triage',
  'sipges-code-quality',
  'sipges-deps-bump',
  'sipges-e2e-stabilize',
  'sipges-go-port',
  'sipges-odd-task',
  'sipges-parallel-agents',
  'sipges-phone-check',
  'sipges-rust-engine',
  'sipges-self-improve',
  'sipges-sync-main',
  'sipges-task-pr',
  'sipges-verify',
];
test('Codex discovers the recurring SIPGES skills and the explicitly requested Neon skills', () => {
  const dir = path.join(root, '.agents/skills');
  const expected = sipgesSkills;
  const vendor = ['neon', 'neon-postgres'];
  const gentle = [
    'chained-pr',
    'cognitive-doc-design',
    'judgment-day',
    'skill-creator',
    'skill-improver',
    'typescript',
    'work-unit-commits',
    'zod-4',
  ];
  assert.deepEqual(readdirSync(dir).sort(), [...expected, ...vendor, ...gentle].sort());
  for (const name of expected) {
    const text = readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8');
    assert.match(text, new RegExp(`^---\\nname: ${name}\\n`));
    assert.match(text, /description: "Use when/);
    assert.doesNotMatch(text, /allowed-tools:|disable-model-invocation:/);
    assert.ok(text.includes('developers.openai.com/codex/skills'));
  }
  const evidence = readFileSync(path.join(root, 'docs/agents/skills.md'), 'utf8');
  for (const name of expected) assert.ok(evidence.includes(name));
  const lock = JSON.parse(readFileSync(path.join(root, 'skills-lock.json'), 'utf8'));
  for (const name of vendor) {
    const text = readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8');
    assert.match(text, new RegExp(`^---\\nname: ${name}\\n`));
    assert.ok(
      text.includes(`https://github.com/neondatabase/agent-skills/tree/main/skills/${name}`),
    );
    assert.equal(lock.skills[name].source, 'neondatabase/agent-skills');
    assert.equal(lock.skills[name].skillPath, `skills/${name}/SKILL.md`);
    assert.match(lock.skills[name].computedHash, /^[a-f0-9]{64}$/);
  }
  for (const name of gentle) {
    const text = readFileSync(path.join(dir, name, 'SKILL.md'));
    assert.match(text.toString('utf8'), new RegExp(`^---\\nname: ${name}\\n`));
    assert.match(lock.skills[name].source, /^Gentleman-Programming\/(gentle-ai|Gentleman-Skills)$/);
    assert.equal(lock.skills[name].computedHash, createHash('sha256').update(text).digest('hex'));
    assert.ok(evidence.includes(name));
  }
});
test('verification never starts a service or guesses a database connection and propagates failures', () =>
  fixture((dir) => {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    const calls = path.join(dir, 'calls');
    for (const [name, script] of Object.entries({
      git: `echo '${dir}'`,
      pnpm: `echo "$*" >> '${calls}'; exit 7`,
      pg_isready: `echo pg >> '${calls}'; exit 0`,
      service: `echo service >> '${calls}'`,
    }))
      writeFileSync(path.join(bin, name), '#!/bin/sh\n' + script + '\n', { mode: 0o755 });
    const env = { ...process.env, PATH: bin + ':' + process.env.PATH };
    delete env.SIPGES_TEST_DATABASE_URL;
    const result = spawnSync('bash', [path.join(root, 'scripts/verify.sh')], {
      env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 7);
    assert.equal(readFileSync(calls, 'utf8'), 'check\n');
    assert.match(result.stdout, /omitidas|skipped/);
  }));
test('ODD dry-run preserves bytes and real close allocates the next log number once', () =>
  fixture((dir) => {
    const file = path.join(dir, 'odd.md');
    const initial =
      '- T14 [ ] S3 — E2E; commit: pending\n## Log\n- L4 (older): old\n- L2 (first): first\n';
    writeFileSync(file, initial);
    const args = [
      path.join(root, 'scripts/odd-close-task.mjs'),
      '--task',
      'T14',
      '--label',
      'T14 verification',
      '--text',
      'Synthetic proof',
      '--file',
      file,
    ];
    const dry = spawnSync(process.execPath, [...args, '--dry-run'], { encoding: 'utf8' });
    assert.equal(dry.status, 0);
    assert.equal(readFileSync(file, 'utf8'), initial);
    assert.match(dry.stdout, /commit: see L5/);
    assert.equal(spawnSync(process.execPath, args).status, 0);
    assert.match(readFileSync(file, 'utf8'), /- L5 \(T14 verification\): Synthetic proof/);
    const closed = readFileSync(file, 'utf8');
    assert.notEqual(spawnSync(process.execPath, args).status, 0);
    assert.equal(readFileSync(file, 'utf8'), closed);
  }));
test('review-next prints the provider command verbatim and stops on consent', () => {
  const script = path.join(root, 'scripts/agents/review-next.sh');
  const run = (value) =>
    spawnSync('bash', [script], { input: JSON.stringify(value), encoding: 'utf8' });
  const command = 'gentle-ai review status --cwd=/a --token=x';
  const assessed = run({
    risk: 'high',
    review_due: true,
    review_due_reason: 'high_risk',
    next_transition: { operation: 'review.status', command },
  });
  assert.equal(assessed.status, 0, assessed.stderr);
  assert.equal(
    assessed.stdout,
    `risk=high review_due=true reason=high_risk\ntransition=none operation=review.status\ncommand=${command}\n`,
  );
  const stopped = run({ next_transition: { action: 'stop', reason_code: 'rdd_disabled' } });
  assert.equal(stopped.stdout, 'transition=stop operation=none\nreason_code=rdd_disabled\n');
  const consent = run({ schema: 'gentle-ai.review-integration.consent/v3', choices: [] });
  assert.equal(consent.status, 3);
  assert.match(consent.stdout, /^CONSENT /);
});
test('ODD rejects blank evidence and multiline labels without changing the task', () =>
  fixture((dir) => {
    const file = path.join(dir, 'odd.md');
    const initial = '- T14 [ ] commit: pending\n- L1 (one): first\n';
    writeFileSync(file, initial);
    for (const [label, text] of [
      ['T14', '   '],
      ['T14\n- T13 [x]', 'Proof'],
    ]) {
      const result = spawnSync(process.execPath, [
        path.join(root, 'scripts/odd-close-task.mjs'),
        '--task',
        'T14',
        '--label',
        label,
        '--text',
        text,
        '--file',
        file,
      ]);
      assert.notEqual(result.status, 0);
      assert.equal(readFileSync(file, 'utf8'), initial);
    }
  }));
test('ODD status lists open tasks in either checkbox style and hides finished features', () =>
  fixture((dir) => {
    writeFileSync(
      path.join(dir, 'done.md'),
      '# Done feature\n## Tasks\n- T1 [x] S1 — shipped; commit: see L1\n',
    );
    writeFileSync(
      path.join(dir, 'open.md'),
      '# Open feature\n- T1 [x] S1 — first\n- T2 [ ] S1 — second step\n- [ ] P3 (not started): third\n',
    );
    const script = path.join(root, 'scripts/odd-status.mjs');
    const run = (...args) =>
      spawnSync(process.execPath, [script, '--dir', dir, ...args], { encoding: 'utf8' });
    const open = run();
    assert.equal(open.status, 0);
    assert.match(open.stdout, /Open feature \(open\.md\): 1\/3/);
    assert.match(open.stdout, /T2 — S1 — second step/);
    assert.match(open.stdout, /P3 — \(not started\): third/);
    assert.doesNotMatch(open.stdout, /Done feature/);
    assert.match(open.stdout, /1 ODD cerrado/);
    const all = run('--all');
    assert.match(all.stdout, /Done feature \(done\.md\): 1\/1/);
    const json = JSON.parse(run('--json').stdout);
    assert.deepEqual(
      json.map((f) => [f.file, f.done, f.total, f.open.map((t) => t.id)]),
      [
        ['done.md', 1, 1, []],
        ['open.md', 1, 3, ['T2', 'P3']],
      ],
    );
  }));
test('Engram wrapper never installs outside the cloud and keeps MCP stdout clean', () =>
  fixture((dir) => {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    const calls = path.join(dir, 'calls');
    for (const name of ['curl', 'tar'])
      writeFileSync(path.join(bin, name), `#!/bin/sh\necho ${name} >> '${calls}'\n`, {
        mode: 0o755,
      });
    const script = path.join(root, 'scripts/agents/engram.mjs');
    const base = { PATH: bin, HOME: dir };
    const local = spawnSync(process.execPath, [script, 'install'], { env: base, encoding: 'utf8' });
    assert.equal(local.status, 1);
    assert.match(local.stderr, /Engram is not installed/);
    assert.throws(() => readFileSync(calls));
    const engram = path.join(bin, 'engram');
    writeFileSync(
      engram,
      `#!/bin/sh\necho "$ENGRAM_PROJECT $*" >> '${calls}'\n[ "$1" = sync ] && echo imported\nexit 0\n`,
      { mode: 0o755 },
    );
    const mcp = spawnSync(process.execPath, [script, 'mcp'], {
      env: { ...base, SIPGES_ENGRAM_BIN: engram },
      encoding: 'utf8',
    });
    assert.equal(mcp.status, 0);
    assert.equal(mcp.stdout, '');
    assert.equal(readFileSync(calls, 'utf8'), 'sipges sync --import\nsipges mcp --tools=agent\n');
  }));
test('Claude Code and Codex start Engram through the wrapper and deny real data reads', () => {
  const mcp = JSON.parse(readFileSync(path.join(root, '.mcp.json'), 'utf8'));
  assert.deepEqual(mcp.mcpServers.engram, {
    command: 'node',
    args: ['scripts/agents/engram.mjs', 'mcp'],
  });
  const codex = readFileSync(path.join(root, '.codex/config.toml'), 'utf8');
  assert.match(
    codex,
    /\[mcp_servers\.engram\]\ncommand = "node"\nargs = \["scripts\/agents\/engram\.mjs", "mcp"\]/,
  );
  const settings = JSON.parse(readFileSync(path.join(root, '.claude/settings.json'), 'utf8'));
  assert.ok(settings.permissions.deny.includes('Read(./data/seed.json)'));
  assert.ok(settings.permissions.deny.includes('Read(./data/*.db)'));
  const manifest = JSON.parse(readFileSync(path.join(root, '.engram/manifest.json'), 'utf8'));
  assert.ok(manifest.chunks.length > 0);
});

test('Claude Code discovers the SIPGES and Neon skills through links to .agents/skills', () => {
  const dir = path.join(root, '.claude/skills');
  const linked = [...sipgesSkills, 'neon', 'neon-postgres'];
  assert.deepEqual(readdirSync(dir).sort(), [...linked].sort());
  for (const name of linked) {
    assert.equal(readlinkSync(path.join(dir, name)), `../../.agents/skills/${name}`);
    assert.match(
      readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8'),
      new RegExp(`^---\\nname: ${name}\\n`),
    );
  }
});
test('the tab watcher reports blocked tabs, text consent prompts, finished tabs and new merges', () =>
  fixture((dir) => {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    const terminals = [
      { address: 't1', agent: 'claude-code', state: 'live', status: 'working', where: 's / a' },
      { address: 't2', agent: 'claude-code', state: 'live', status: 'blocked', where: 's / b' },
      { address: 't3', agent: 'claude-code', state: 'live', status: 'idle', where: 's / c' },
      { address: 't4', agent: 'claude-code', state: 'live', status: 'done', where: 's / d' },
    ];
    writeFileSync(path.join(dir, 'ls.json'), JSON.stringify({ terminals }));
    for (const [name, script] of Object.entries({
      hc: `case "$1" in ls) cat '${dir}/ls.json';; read) [ "$2" = t3 ] && printf 'Revisión\\nRespondé con 1, 2 o 3\\n'; exit 0;; esac`,
      gh: `printf '217 feat: one\\n225 feat: two\\n'`,
    }))
      writeFileSync(path.join(bin, name), '#!/bin/sh\n' + script + '\n', { mode: 0o755 });
    const state = path.join(dir, 'seen');
    writeFileSync(state, '217\n');
    const env = { ...process.env, PATH: bin + ':' + process.env.PATH, WATCH_TABS_STATE: state };
    const script = path.join(root, 'scripts/agents/watch-tabs.sh');
    const result = spawnSync('bash', [script, '--once'], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      'BLOCKED t2 s / b\nCONSENT t3 s / c\nDONE t4 s / d\nMERGED #225 feat: two\n',
    );
    assert.equal(readFileSync(state, 'utf8'), '217\n225\n');
    const status = spawnSync('bash', [script, '--status'], { env, encoding: 'utf8' });
    assert.equal(status.stdout.split('\n')[0], 't1\tworking\ts / a');
    const until = spawnSync('bash', [script, '--until', 'DONE', '--interval', '0'], {
      env,
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(until.status, 0, until.stderr);
    assert.match(until.stdout, /^DONE t4 s \/ d$/m);
    const mixed = spawnSync('bash', [script, '--once', '--until', 'DONE'], { env });
    assert.equal(mixed.status, 2);
    const again = spawnSync('bash', [script, '--once'], { env, encoding: 'utf8' });
    assert.doesNotMatch(again.stdout, /MERGED/);
    const help = spawnSync('bash', [script, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^Usage: scripts\/agents\/watch-tabs\.sh/);
  }));
test('the main-merge helper keeps main first and renumbers the branch ODD log entry', () =>
  fixture((dir) => {
    mkdirSync(path.join(dir, 'odd/tasks'), { recursive: true });
    const log = 'odd/tasks/demo.md';
    writeFileSync(
      path.join(dir, log),
      '## Log\n- L1 start\n<<<<<<< HEAD\n- L2 branch work\n=======\n- L2 main work\n- L3 more main\n>>>>>>> origin/main\n',
    );
    writeFileSync(
      path.join(dir, 'CHANGELOG.md'),
      '# Changelog\n<<<<<<< HEAD\n- branch entry\n=======\n- main entry\n>>>>>>> origin/main\n- older\n',
    );
    const script = path.join(
      root,
      '.agents/skills/sipges-sync-main/scripts/resolve-doc-conflicts.py',
    );
    const result = spawnSync('python3', [script, log, 'CHANGELOG.md'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${log} 1\nCHANGELOG.md 1\n`);
    assert.equal(
      readFileSync(path.join(dir, log), 'utf8'),
      '## Log\n- L1 start\n- L2 main work\n- L3 more main\n- L4 branch work\n',
    );
    assert.equal(
      readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'),
      '# Changelog\n- main entry\n- branch entry\n- older\n',
    );
  }));
test('fast verification runs static checks in parallel, tests only affected packages and propagates failures', () =>
  fixture((dir) => {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    const calls = path.join(dir, 'calls');
    const run = (failing, changed) => {
      writeFileSync(calls, '');
      for (const [name, script] of Object.entries({
        git: `if [ "$1" = rev-parse ]; then echo '${dir}'; elif [ "$1" = diff ]; then echo '${changed}' | grep -E '^(scripts|[.]agents|[.]claude)/'; fi`,
        pnpm: `echo "$*" >> '${calls}'; case "$*" in ${failing}) exit 7;; esac; exit 0`,
        pg_isready: `echo pg >> '${calls}'; exit 0`,
      }))
        writeFileSync(path.join(bin, name), '#!/bin/sh\n' + script + '\n', { mode: 0o755 });
      const env = { ...process.env, PATH: bin + ':' + process.env.PATH };
      delete env.SIPGES_TEST_DATABASE_URL;
      delete env.SIPGES_VERIFY_BASE;
      const result = spawnSync('bash', [path.join(root, 'scripts/verify-fast.sh')], {
        env,
        encoding: 'utf8',
      });
      return {
        status: result.status,
        calls: readFileSync(calls, 'utf8').trim().split('\n').sort(),
      };
    };
    const affected = '--filter ...[origin/main]';
    const green = run('never-matches', 'apps/web/src/a.ts');
    assert.equal(green.status, 0);
    assert.deepEqual(green.calls, [
      `${affected} --workspace-concurrency=1 run test`,
      `${affected} run typecheck`,
      'boundaries',
      'lint',
      'odd:check',
    ]);
    const tooling = run('never-matches', 'scripts/verify.sh');
    assert.ok(tooling.calls.includes('test:tooling'));
    const red = run('boundaries', 'apps/web/src/a.ts');
    assert.equal(red.status, 1);
    assert.ok(red.calls.includes(`${affected} --workspace-concurrency=1 run test`));
  }));
test('odd:check fails on a repeated task or log id and passes on unique ids', () =>
  fixture((dir) => {
    const run = () =>
      spawnSync(process.execPath, [path.join(root, 'scripts/odd-check-ids.mjs'), dir], {
        encoding: 'utf8',
      });
    writeFileSync(
      path.join(dir, 'f.md'),
      '# F\n## Tasks\n- T1 [x] a\n- T2 [ ] b\n## Log\n- L1 — a\n- L2 — b\n',
    );
    assert.equal(run().status, 0);
    writeFileSync(
      path.join(dir, 'f.md'),
      '# F\n## Tasks\n- T1 [x] a\n## Log\n- L1 — a\n- L2 — b\n- L2 — c\n',
    );
    const failed = run();
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /f\.md: L2 appears more than once under "## Log"/);
  }));
test('two branches appending to a feature log merge locally without a conflict', () =>
  fixture((dir) => {
    const git = (...args) => {
      const r = spawnSync(
        'git',
        ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args],
        { cwd: dir, encoding: 'utf8' },
      );
      assert.equal(r.status, 0, r.stderr);
      return r.stdout;
    };
    git('init', '-q', '-b', 'main');
    mkdirSync(path.join(dir, 'odd/tasks'), { recursive: true });
    writeFileSync(
      path.join(dir, '.gitattributes'),
      readFileSync(path.join(root, '.gitattributes')),
    );
    const log = path.join(dir, 'odd/tasks/f.md');
    writeFileSync(log, '# F\n## Log\n- L1 — start\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    git('checkout', '-qb', 'a');
    writeFileSync(log, '# F\n## Log\n- L1 — start\n- L2 — from a\n');
    git('commit', '-qam', 'a');
    git('checkout', '-q', 'main');
    writeFileSync(log, '# F\n## Log\n- L1 — start\n- L3 — from main\n');
    git('commit', '-qam', 'main');
    git('merge', '-q', '--no-edit', 'a');
    const merged = readFileSync(log, 'utf8');
    assert.match(merged, /L2 — from a/);
    assert.match(merged, /L3 — from main/);
    assert.doesNotMatch(merged, /<<<<<<<|>>>>>>>/);
  }));

// Runs the install script with stubs for the commands it calls; each stub logs its arguments.
const runPlaywrightInstall = (runner, failures) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sipges-playwright-install-'));
  const log = path.join(dir, 'calls.log');
  const counter = path.join(dir, 'attempts');
  const stub = (name, body) =>
    writeFileSync(path.join(dir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  stub(
    'timeout',
    `echo "timeout $*" >> "${log}"
n=$(($(cat "${counter}" 2>/dev/null || echo 0) + 1)); echo $n > "${counter}"
[ "$n" -gt ${failures} ]`,
  );
  // pkill answers 1 when nothing matches, which must not stop the loop.
  stub('sudo', `echo "sudo $*" >> "${log}"\n[ "$1" != pkill ]`);
  const result = spawnSync('bash', ['scripts/ci-playwright-install.sh', 'chromium'], {
    cwd: root,
    env: { PATH: `${dir}:${process.env.PATH}`, SIPGES_CI_RUNNER: runner },
    encoding: 'utf8',
  });
  const calls = readFileSync(log, 'utf8').trim().split('\n');
  rmSync(dir, { recursive: true, force: true });
  return { ...result, calls };
};

test('playwright install frees the dpkg lock between attempts on GitHub-hosted runners', () => {
  const { status, stderr, calls } = runPlaywrightInstall('github-hosted', 1);
  assert.equal(status, 0, stderr);
  assert.match(stderr, /keeps the dpkg lock/);
  assert.deepEqual(calls, [
    'timeout 480 pnpm --filter @sipges/e2e exec playwright install --with-deps chromium',
    'sudo pkill -x apt-get',
    'sudo timeout 120 dpkg --configure -a',
    'timeout 480 pnpm --filter @sipges/e2e exec playwright install --with-deps chromium',
  ]);
});

test('playwright install on self-hosted runners keeps 5 minutes, no apt and no sudo', () => {
  const { status, calls } = runPlaywrightInstall('self-hosted', 1);
  assert.equal(status, 0);
  assert.deepEqual(calls, [
    'timeout 300 pnpm --filter @sipges/e2e exec playwright install chromium',
    'timeout 300 pnpm --filter @sipges/e2e exec playwright install chromium',
  ]);
});

test('playwright install fails after three attempts and repairs only between them', () => {
  const { status, calls } = runPlaywrightInstall('github-hosted', 3);
  assert.equal(status, 1);
  assert.equal(calls.filter((call) => call.startsWith('timeout 480')).length, 3);
  assert.equal(calls.filter((call) => call.includes('dpkg')).length, 2);
});

test('CI installs Playwright through the script and names the runner', () => {
  const ci = readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /run: bash scripts\/ci-playwright-install\.sh \$\{\{ matrix\.browser \}\}/);
  assert.match(ci, /SIPGES_CI_RUNNER: \$\{\{ runner\.environment \}\}/);
});
