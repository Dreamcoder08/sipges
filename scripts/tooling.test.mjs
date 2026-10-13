import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
const root = process.cwd();
const fixture = (run) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mascli-tooling-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
test('Codex discovers only four skills with recurrence evidence and valid frontmatter', () => {
  const dir = path.join(root, '.agents/skills');
  const expected = ['mascli-archify', 'mascli-odd-task', 'mascli-task-pr', 'mascli-verify'];
  assert.deepEqual(readdirSync(dir).sort(), expected);
  for (const name of expected) {
    const text = readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8');
    assert.match(text, new RegExp(`^---\\nname: ${name}\\n`));
    assert.match(text, /description: "Use when/);
    assert.doesNotMatch(text, /allowed-tools:|disable-model-invocation:/);
    assert.ok(text.includes('developers.openai.com/codex/skills'));
  }
  const evidence = readFileSync(path.join(root, 'docs/agents/skills.md'), 'utf8');
  for (const name of expected) assert.ok(evidence.includes(name));
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
    delete env.MASCLI_TEST_DATABASE_URL;
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
