import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
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
  // Gentle AI skills come from the global `gentle-ai install`; repo copies only shadowed them.
  assert.deepEqual(readdirSync(dir).sort(), [...expected, ...vendor].sort());
  assert.equal(existsSync(path.join(root, '.pi/settings.json')), false);
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
  assert.deepEqual(Object.keys(lock.skills).sort(), vendor);
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
test('the Engram manifest conflict resolves to the union of both sides by chunk id', () =>
  fixture((dir) => {
    const git = (...args) => {
      const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.st', ...args], {
        cwd: dir,
        encoding: 'utf8',
      });
      return result;
    };
    const chunk = (id, at) => ({ id, created_at: at, sessions: 1, memories: 1, prompts: 0 });
    const manifest = path.join(dir, '.engram/manifest.json');
    const write = (chunks) =>
      writeFileSync(manifest, `${JSON.stringify({ version: 2, chunks }, null, 2)}\n`);
    git('init', '-q', '-b', 'main');
    mkdirSync(path.join(dir, '.engram'));
    const base = chunk('a', '2026-01-01');
    write([base]);
    git('add', '.');
    git('commit', '-qm', 'base');
    git('switch', '-qc', 'side');
    write([base, chunk('c', '2026-01-03')]);
    git('commit', '-qam', 'side');
    git('switch', '-q', 'main');
    write([base, chunk('b', '2026-01-02')]);
    git('commit', '-qam', 'main');
    assert.notEqual(git('merge', 'side').status, 0);
    const resolve = (cwd) =>
      spawnSync(process.execPath, [path.join(root, 'scripts/agents/engram-manifest-merge.mjs')], {
        cwd,
        encoding: 'utf8',
      });
    const merged = resolve(dir);
    assert.equal(merged.status, 0, merged.stderr);
    const { version, chunks } = JSON.parse(readFileSync(manifest, 'utf8'));
    assert.equal(version, 2);
    assert.deepEqual(
      chunks.map((entry) => entry.id),
      ['a', 'b', 'c'],
    );
    assert.equal(git('diff', '--name-only', '--diff-filter=U').stdout, '');
    assert.equal(resolve(dir).status, 1);
  }));
test('fmt:changed formats only the files changed against the base', () =>
  fixture((dir) => {
    const git = (...args) =>
      spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.st', ...args], { cwd: dir });
    git('init', '-q', '-b', 'main');
    writeFileSync(path.join(dir, 'old.md'), 'old\n');
    writeFileSync(path.join(dir, 'removed.md'), 'x\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    git('branch', 'base');
    writeFileSync(path.join(dir, 'new.md'), 'new\n');
    git('add', '.');
    git('commit', '-qm', 'more');
    git('rm', '-q', 'removed.md');
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    const log = path.join(dir, 'calls');
    writeFileSync(path.join(bin, 'prettier'), `#!/bin/sh\necho "$*" >> "${log}"\n`, {
      mode: 0o755,
    });
    const run = (base) =>
      spawnSync('bash', [path.join(root, 'scripts/fmt-changed.sh')], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SIPGES_VERIFY_BASE: base },
      });
    const result = run('base');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(log, 'utf8'), '--write --ignore-unknown new.md\n');
    assert.notEqual(run('no-such-base').status, 0);
    assert.equal(readFileSync(log, 'utf8'), '--write --ignore-unknown new.md\n');
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
  assert.equal(run({ schema: 'gentle-ai.review-integration.consent/v4' }).status, 3);
  const empty = spawnSync('bash', [script], { input: ' \n', encoding: 'utf8' });
  assert.equal(empty.status, 2);
});
test('test-pg starts one loopback server per checkout and deletes only its own directory', (t) => {
  if (spawnSync('sh', ['-c', 'command -v initdb']).status !== 0) {
    t.skip('initdb is not installed');
    return;
  }
  return fixture((dir) => {
    const env = { ...process.env, TEST_PG_ROOT: path.join(dir, 'pg'), TEST_PG_PORT: '56439' };
    const run = (action) =>
      spawnSync('bash', [path.join(root, 'scripts/agents/test-pg.sh'), action], {
        cwd: dir,
        env,
        encoding: 'utf8',
      });
    assert.equal(run('url').status, 1);
    const up = run('up');
    assert.equal(up.status, 0, up.stderr);
    assert.match(up.stdout, /^postgres:\/\/sipges_test@127\.0\.0\.1:\d+\/sipges_test\n$/);
    try {
      assert.equal(run('up').stdout, up.stdout);
      assert.equal(run('url').stdout, up.stdout);
    } finally {
      assert.equal(run('down').status, 0);
    }
    assert.equal(run('url').status, 1);
    assert.deepEqual(readdirSync(path.join(dir, 'pg')), []);
    assert.equal(run('nope').status, 2);
  });
});
test('new-worktree starts from origin/main and reuses an existing branch', () =>
  fixture((dir) => {
    const git = (cwd, ...args) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    const origin = path.join(dir, 'origin.git');
    git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
    const clone = path.join(dir, 'clone');
    git(dir, 'clone', '-q', origin, clone);
    git(
      clone,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@e.st',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'one',
    );
    git(clone, 'push', '-q', 'origin', 'HEAD:main');
    const head = git(clone, 'rev-parse', 'HEAD');
    const script = path.join(root, 'scripts/agents/new-worktree.sh');
    const run = (...args) => spawnSync('bash', [script, ...args], { cwd: clone, encoding: 'utf8' });

    const created = run('unit', 'feat/unit');
    assert.equal(created.status, 0, created.stderr);
    const target = created.stdout.trim();
    assert.equal(target, path.join(realpathSync(clone), '.worktrees/unit'));
    assert.equal(git(target, 'rev-parse', 'HEAD'), head);
    assert.equal(git(target, 'branch', '--show-current'), 'feat/unit');

    assert.equal(run('unit', 'feat/unit').status, 1);
    git(clone, 'worktree', 'remove', target);
    const reused = run('again', 'feat/unit');
    assert.equal(reused.status, 0, reused.stderr);
    assert.equal(git(reused.stdout.trim(), 'branch', '--show-current'), 'feat/unit');

    assert.equal(run('../escape', 'b').status, 2);
    assert.equal(run('only-name').status, 2);
  }));
test('land-pr reports without merging, and merges only with --merge', () =>
  fixture((dir) => {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    const log = path.join(dir, 'gh.log');
    const flaked = path.join(dir, 'flaked');
    const unknownSeen = path.join(dir, 'unknown-seen');
    const headSeen = path.join(dir, 'head-seen');
    const views = path.join(dir, 'views');
    writeFileSync(
      path.join(bin, 'gh'),
      `#!/bin/sh
echo "$*" >> "${log}"
if [ -n "$FAKE_DOWN" ] && echo "$*" | grep -qE "$FAKE_DOWN"; then
  echo 'HTTP 502' >&2
  exit 1
fi
if [ -n "$FAKE_FLAKY" ] && [ ! -e "${flaked}" ] && echo "$*" | grep -qE "$FAKE_FLAKY"; then
  touch "${flaked}"
  echo 'HTTP 502' >&2
  exit 1
fi
case "$*" in
  *mergeable,mergeStateStatus*)
    if [ -n "$FAKE_FIRST_MERGE_STATE" ] && [ ! -e "${unknownSeen}" ]; then
      touch "${unknownSeen}"
      echo "$FAKE_FIRST_MERGE_STATE"
    else
      echo "$FAKE_MERGE_STATE"
    fi ;;
  "pr checks"*) echo "\${FAKE_CHECKS-pass}" ;;
  *headRefOid*)
    if [ -n "$FAKE_LATER_HEAD" ] && [ -e "${headSeen}" ]; then echo "$FAKE_LATER_HEAD"; else touch "${headSeen}"; echo head456; fi ;;
  *isDraft*) echo true ;;
  "pr merge"*) exit "\${FAKE_MERGE_EXIT:-0}" ;;
  *state,mergeCommit*) echo "\${FAKE_MERGED-abc123}" ;;
  "pr view"*"--json state "*) echo "\${FAKE_PR_STATE:-OPEN}" ;;
  "run list --workflow ci.yml"*) echo "\${FAKE_CI-success}" ;;
  "run list"*skipped*) echo "\${FAKE_ACTIVE_RUN-$FAKE_RUN}" ;;
  "run list"*) echo "$FAKE_RUN" ;;
  "run view"*)
    if [ -n "$FAKE_RUNNING_VIEWS" ] && [ "$(wc -l < "${views}" 2>/dev/null || echo 0)" -lt "$FAKE_RUNNING_VIEWS" ]; then
      echo seen >> "${views}"
    else
      echo "\${FAKE_DEPLOY-success}"
    fi ;;
esac
`,
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(bin, 'git'),
      `#!/bin/sh
echo "git $*" >> "${log}"
case "$*" in
  fetch*) exit 0 ;;
  merge-base*) exit "\${FAKE_ANCESTOR:-0}" ;;
  rev-parse*) echo "\${FAKE_MAIN-newer999}" ;;
esac
`,
      { mode: 0o755 },
    );
    const land = (args, extra = {}) => {
      writeFileSync(log, '');
      rmSync(flaked, { force: true });
      rmSync(unknownSeen, { force: true });
      rmSync(headSeen, { force: true });
      rmSync(views, { force: true });
      const result = spawnSync('bash', [path.join(root, 'scripts/agents/land-pr.sh'), ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          LAND_PR_POLL: '0',
          LAND_PR_ATTEMPTS: '3',
          FAKE_RUN: '77',
          FAKE_MERGE_STATE: 'MERGEABLE CLEAN',
          ...extra,
        },
      });
      return { ...result, calls: readFileSync(log, 'utf8') };
    };

    const ready = land(['12']);
    assert.equal(ready.status, 0);
    assert.equal(ready.stdout, 'READY #12\n');
    assert.doesNotMatch(ready.calls, /pr merge|pr ready/);

    const dirty = land(['12', '--merge'], { FAKE_MERGE_STATE: 'CONFLICTING DIRTY' });
    assert.equal(dirty.status, 3);
    assert.equal(dirty.stdout, 'CONFLICT #12 CONFLICTING DIRTY\n');
    assert.doesNotMatch(dirty.calls, /pr merge/);

    const red = land(['12', '--merge'], { FAKE_CHECKS: 'fail pass' });
    assert.equal(red.status, 4);
    assert.equal(red.stdout, 'CHECKS_FAILED #12\n');
    assert.doesNotMatch(red.calls, /pr merge/);

    const landed = land(['12', '--merge']);
    assert.equal(landed.status, 0);
    assert.equal(landed.stdout, 'MERGED #12 abc123\nDEPLOYED #12 77\n');
    assert.match(landed.calls, /pr ready 12\n/);
    assert.match(landed.calls, /pr merge 12 --merge --match-head-commit head456\n/);
    assert.match(
      landed.calls,
      /git merge-base --is-ancestor head456 refs\/remotes\/origin\/main\n/,
    );

    const failed = land(['12', '--merge'], { FAKE_DEPLOY: 'failure' });
    assert.equal(failed.status, 5);
    assert.equal(failed.stdout, 'MERGED #12 abc123\nDEPLOY_FAILED #12 77 failure\n');

    const none = land(['12', '--merge'], { FAKE_RUN: '', FAKE_CI: '', LAND_PR_ATTEMPTS: '30' });
    assert.equal(none.status, 6);
    assert.equal(none.stdout, 'MERGED #12 abc123\nNO_DEPLOY #12 abc123\n');
    assert.equal(none.calls.match(/run list --workflow deploy-workers/g).length, 8);

    assert.equal(land([]).status, 2);
    assert.equal(land(['12;x']).status, 2);
    const twoNumbers = land(['12', '34', '--merge']);
    assert.equal(twoNumbers.status, 2);
    assert.equal(twoNumbers.calls, '');

    // Transient gh errors never read as a result.
    for (const flaky of [
      'pr checks',
      'mergeable',
      'headRefOid',
      'pr ready',
      'state,mergeCommit',
      'run list',
      'run view',
    ]) {
      const retried = land(['12', '--merge'], { FAKE_FLAKY: flaky });
      assert.equal(retried.status, 0, flaky);
      assert.equal(retried.stdout, 'MERGED #12 abc123\nDEPLOYED #12 77\n', flaky);
    }

    // A 502 on the merge call can hide a merge that happened; only the repository says which.
    const hidden = land(['12', '--merge'], { FAKE_MERGE_EXIT: '1' });
    assert.equal(hidden.status, 0);
    assert.equal(hidden.stdout, 'MERGED #12 abc123\nDEPLOYED #12 77\n');
    const stale = land(['12', '--merge'], { FAKE_ANCESTOR: '1' });
    assert.equal(stale.status, 7);
    assert.equal(stale.stdout, 'MERGE_UNCONFIRMED #12 head456\n');
    const refused = land(['12', '--merge'], { FAKE_MERGE_EXIT: '1', FAKE_MERGED: '' });
    assert.equal(refused.status, 7);
    assert.equal(refused.stdout, 'MERGE_UNCONFIRMED #12 head456\n');

    // A merge state GitHub has not computed is neither conflict nor permission.
    const computed = land(['12', '--merge'], { FAKE_FIRST_MERGE_STATE: 'UNKNOWN UNKNOWN' });
    assert.equal(computed.status, 0);
    const uncomputed = land(['12', '--merge'], { FAKE_MERGE_STATE: 'UNKNOWN UNKNOWN' });
    assert.equal(uncomputed.status, 7);
    assert.equal(uncomputed.stdout, 'UNKNOWN_STATE #12 UNKNOWN UNKNOWN\n');
    assert.doesNotMatch(uncomputed.calls, /pr merge/);

    const pending = land(['12', '--merge'], { FAKE_CHECKS: 'pass pending' });
    assert.equal(pending.status, 7);
    assert.equal(pending.stdout, 'CHECKS_PENDING #12\n');
    assert.doesNotMatch(pending.calls, /pr merge/);

    // Merges in a row cancel CI on main, which skips the older deploy: not a failure.
    const skipped = land(['12', '--merge'], { FAKE_DEPLOY: 'skipped', FAKE_CI: 'cancelled' });
    assert.equal(skipped.status, 0);
    assert.equal(skipped.stdout, 'MERGED #12 abc123\nDEPLOY_SUPERSEDED #12 77 abc123\n');
    const queued = land(['12', '--merge'], { FAKE_DEPLOY: 'cancelled' });
    assert.equal(queued.status, 0);
    assert.equal(queued.stdout, 'MERGED #12 abc123\nDEPLOY_SUPERSEDED #12 77 abc123\n');
    const ciRed = land(['12', '--merge'], { FAKE_DEPLOY: 'skipped', FAKE_CI: 'failure' });
    assert.equal(ciRed.status, 5);
    assert.equal(ciRed.stdout, 'MERGED #12 abc123\nDEPLOY_FAILED #12 77 skipped\n');
    const lost = land(['12', '--merge'], { FAKE_DEPLOY: '' });
    assert.equal(lost.status, 7);
    assert.equal(lost.stdout, 'MERGED #12 abc123\nDEPLOY_UNKNOWN #12 77\n');

    const noWait = land(['12', '--merge', '--no-deploy-wait']);
    assert.equal(noWait.status, 0);
    assert.equal(noWait.stdout, 'MERGED #12 abc123\n');
    assert.doesNotMatch(noWait.calls, /run list/);

    // The merge is bound to the commit the checks saw.
    const pushed = land(['12', '--merge'], { FAKE_LATER_HEAD: 'head789' });
    assert.equal(pushed.status, 7);
    assert.equal(pushed.stdout, 'HEAD_CHANGED #12 head789\n');
    assert.doesNotMatch(pushed.calls, /pr merge/);

    // Lasting failures show their cause and answer at once; refusals are not "ask again".
    const down = land(['12'], { FAKE_DOWN: 'pr view' });
    assert.equal(down.status, 7);
    assert.equal(down.stdout, 'UNKNOWN_STATE #12 unreadable\n');
    assert.match(down.stderr, /HTTP 502/);
    assert.equal(down.calls.split('\n').filter(Boolean).length, 3);
    const closed = land(['12', '--merge'], { FAKE_PR_STATE: 'CLOSED' });
    assert.equal(closed.status, 3);
    assert.equal(closed.stdout, 'NOT_OPEN #12 CLOSED\n');
    const blocked = land(['12', '--merge'], {
      FAKE_MERGE_STATE: 'MERGEABLE BLOCKED',
      LAND_PR_ATTEMPTS: '6',
    });
    assert.equal(blocked.status, 3);
    assert.equal(blocked.stdout, 'BLOCKED #12\n');
    assert.doesNotMatch(blocked.calls, /pr merge/);

    const staleBlock = land(['12', '--merge'], { FAKE_FIRST_MERGE_STATE: 'MERGEABLE BLOCKED' });
    assert.equal(staleBlock.status, 0);
    const noChecks = land(['12'], { FAKE_DOWN: 'pr checks' });
    assert.equal(noChecks.status, 7);
    assert.equal(noChecks.stdout, 'UNKNOWN_STATE #12 checks\n');
    assert.match(noChecks.stderr, /HTTP 502/);

    // A running deploy is waited for, and only this commit's CI gives its result meaning.
    const running = land(['12', '--merge'], { FAKE_RUNNING_VIEWS: '2' });
    assert.equal(running.status, 0);
    assert.equal(running.stdout, 'MERGED #12 abc123\nDEPLOYED #12 77\n');
    assert.equal(running.calls.match(/run view/g).length, 3);
    const early = land(['12', '--merge'], { FAKE_CI: 'pending' });
    assert.equal(early.status, 7);
    assert.equal(early.stdout, 'MERGED #12 abc123\nDEPLOY_UNKNOWN #12 77\n');
    const ciFailed = land(['12', '--merge'], { FAKE_CI: 'failure' });
    assert.equal(ciFailed.status, 5);
    assert.equal(ciFailed.stdout, 'MERGED #12 abc123\nDEPLOY_FAILED #12 77 ci:failure\n');
    const docsOnly = land(['12', '--merge'], { FAKE_CI: '', LAND_PR_ATTEMPTS: '30' });
    assert.equal(docsOnly.status, 6);
    assert.equal(docsOnly.stdout, 'MERGED #12 abc123\nNO_DEPLOY #12 abc123\n');

    // Unknown never becomes a result: CI still running, CI unreadable, main unreadable or not moved.
    const slow = land(['12', '--merge'], { FAKE_RUN: '', FAKE_CI: 'pending' });
    assert.equal(slow.status, 7);
    assert.equal(slow.stdout, 'MERGED #12 abc123\nDEPLOY_UNKNOWN #12 none\n');
    const ciDown = land(['12', '--merge'], {
      FAKE_RUN: '',
      FAKE_DOWN: 'ci.yml',
      LAND_PR_ATTEMPTS: '30',
    });
    assert.equal(ciDown.status, 7);
    assert.equal(ciDown.stdout, 'MERGED #12 abc123\nDEPLOY_UNKNOWN #12 none\n');
    const unreadCi = land(['12', '--merge'], { FAKE_DEPLOY: 'skipped', FAKE_DOWN: 'ci.yml' });
    assert.equal(unreadCi.status, 7);
    assert.equal(unreadCi.stdout, 'MERGED #12 abc123\nDEPLOY_UNKNOWN #12 77\n');
    for (const extra of [
      { FAKE_DEPLOY: 'cancelled' },
      { FAKE_DEPLOY: 'skipped', FAKE_CI: 'cancelled' },
    ]) {
      const last = land(['12', '--merge'], { ...extra, FAKE_MAIN: 'abc123' });
      assert.equal(last.status, 5);
      assert.equal(last.stdout, `MERGED #12 abc123\nDEPLOY_FAILED #12 77 ${extra.FAKE_DEPLOY}\n`);
    }

    // The skipped run of the previous, cancelled CI can carry this commit; the real deploy follows it.
    const real = land(['12', '--merge'], { FAKE_ACTIVE_RUN: '88' });
    assert.equal(real.status, 0);
    assert.equal(real.stdout, 'MERGED #12 abc123\nDEPLOYED #12 88\n');
    const queuedBehind = land(['12', '--merge'], { FAKE_ACTIVE_RUN: '', FAKE_DEPLOY: 'skipped' });
    assert.equal(queuedBehind.status, 7);
    assert.equal(queuedBehind.stdout, 'MERGED #12 abc123\nDEPLOY_UNKNOWN #12 none\n');
    const staleSkip = land(['12', '--merge'], { FAKE_DEPLOY: 'skipped' });
    assert.equal(staleSkip.status, 7);
    assert.equal(staleSkip.stdout, 'MERGED #12 abc123\nDEPLOY_UNKNOWN #12 77\n');
    const skippedOnly = land(['12', '--merge'], {
      FAKE_ACTIVE_RUN: '',
      FAKE_DEPLOY: 'skipped',
      FAKE_CI: 'cancelled',
    });
    assert.equal(skippedOnly.status, 0);
    assert.equal(skippedOnly.stdout, 'MERGED #12 abc123\nDEPLOY_SUPERSEDED #12 77 abc123\n');

    // Running it again after a lost answer resumes instead of merging twice.
    const again = land(['12', '--merge'], { FAKE_PR_STATE: 'MERGED' });
    assert.equal(again.status, 0);
    assert.equal(again.stdout, 'MERGED #12 abc123\nDEPLOYED #12 77\n');
    assert.doesNotMatch(again.calls, /pr merge/);
  }));
test('ODD close keeps the log style of the document it edits', () =>
  fixture((dir) => {
    const close = path.join(root, 'scripts/odd-close-task.mjs');
    for (const [initial, expected] of [
      ['- T1 [ ] one\n- L7 — Evidence: old\n', '- L8 — T1 proof: Synthetic'],
      ['- T1 [ ] one\n- L7: old\n', '- L8: T1 proof: Synthetic'],
    ]) {
      const file = path.join(dir, 'odd.md');
      writeFileSync(file, initial);
      const result = spawnSync(process.execPath, [
        close,
        '--task',
        'T1',
        '--label',
        'T1 proof',
        '--text',
        'Synthetic',
        '--file',
        file,
      ]);
      assert.equal(result.status, 0);
      const written = readFileSync(file, 'utf8');
      assert.match(written, /- T1 \[x\] one/);
      assert.ok(written.includes(`${expected}\n`));
    }
  }));
test('ODD log-only appends an entry and touches no task', () =>
  fixture((dir) => {
    const file = path.join(dir, 'odd.md');
    const initial = '- T1 [ ] open\n- L1 (one): first\n';
    writeFileSync(file, initial);
    const args = [
      path.join(root, 'scripts/odd-close-task.mjs'),
      '--log-only',
      '--label',
      'Decision',
      '--text',
      'Synthetic',
      '--file',
      file,
    ];
    const dry = spawnSync(process.execPath, [...args, '--dry-run'], { encoding: 'utf8' });
    assert.equal(dry.status, 0);
    assert.match(dry.stdout, /- L2 \(Decision\): Synthetic/);
    assert.equal(readFileSync(file, 'utf8'), initial);
    assert.equal(spawnSync(process.execPath, args).status, 0);
    assert.equal(readFileSync(file, 'utf8'), `${initial}- L2 (Decision): Synthetic\n`);
  }));
test('ODD close refuses to guess the feature document', () =>
  fixture((dir) => {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, 'scripts/odd-close-task.mjs'),
        '--task',
        'T1',
        '--label',
        'x',
        '--text',
        'y',
      ],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--file/);
  }));
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
test('odd:status reads bracketed-word and dash-style tasks', () =>
  fixture((dir) => {
    writeFileSync(
      path.join(dir, 'words.md'),
      '# Words\n- T1 [done] (S1) shipped. Commit: abc.\n- T2 [dropped] (S1) superseded.\n' +
        '- T3 [done, WebKit blocked] (S2) partial.\n- T4 [pending] (S2) later.\n',
    );
    writeFileSync(
      path.join(dir, 'dash.md'),
      '# Dash\n- T1 — S1: built it. Done: `abc`, PR #1 merged.\n' +
        '- T2 — S2: check in production. Route: inline. Commit: n/a.\n' +
        '- T3 — S3: drawer. Commit: this branch. Status: done.\n' +
        '- L1 — request: not a task\n',
    );
    const json = JSON.parse(
      spawnSync(
        process.execPath,
        [path.join(root, 'scripts/odd-status.mjs'), '--dir', dir, '--json'],
        {
          encoding: 'utf8',
        },
      ).stdout,
    );
    assert.deepEqual(
      json.map((f) => [f.file, f.done, f.total, f.open.map((t) => t.id)]),
      [
        ['dash.md', 2, 3, ['T2']],
        ['words.md', 3, 4, ['T4']],
      ],
    );
    assert.equal(json[0].open[0].text, 'S2: check in production. Route: inline.');
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
    for (const args of [
      ['--status', '--until', 'DONE'],
      ['--status', '--interval', '5'],
      ['--until', 'done'],
    ]) {
      assert.equal(spawnSync('bash', [script, ...args], { env }).status, 2, args.join(' '));
    }
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
