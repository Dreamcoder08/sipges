#!/usr/bin/env node
// Resolves a merge conflict in .engram/manifest.json: chunks are append-only, so the answer is both
// sides, one entry per id, oldest first. Run it during the merge, from the repository root.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const manifest = '.engram/manifest.json';
const side = (stage) => {
  const { status, stdout } = spawnSync('git', ['show', `:${stage}:${manifest}`], {
    encoding: 'utf8',
  });
  if (status !== 0) {
    console.error(`no merge conflict in ${manifest}`);
    process.exit(1);
  }
  return JSON.parse(stdout);
};

const ours = side(2);
const theirs = side(3);
const byId = new Map([...ours.chunks, ...theirs.chunks].map((chunk) => [chunk.id, chunk]));
const chunks = [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
writeFileSync(manifest, `${JSON.stringify({ ...ours, chunks }, null, 2)}\n`);
process.exit(spawnSync('git', ['add', manifest], { stdio: 'inherit' }).status ?? 1);
