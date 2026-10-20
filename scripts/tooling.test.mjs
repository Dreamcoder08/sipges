import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
test('Codex discovers four recurring MASCLI skills and the explicitly requested Neon skills', () => {
  const dir = path.join(root, '.agents/skills');
  const expected = ['mascli-archify', 'mascli-odd-task', 'mascli-task-pr', 'mascli-verify'];
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
      env: { ...base, MASCLI_ENGRAM_BIN: engram },
      encoding: 'utf8',
    });
    assert.equal(mcp.status, 0);
    assert.equal(mcp.stdout, '');
    assert.equal(readFileSync(calls, 'utf8'), 'mascli sync --import\nmascli mcp --tools=agent\n');
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
