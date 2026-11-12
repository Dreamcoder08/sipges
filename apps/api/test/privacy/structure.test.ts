import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MCP_TOOLS } from '../../src/contexts/integration/http/mcp-tools.ts';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
const ALL = files(SRC).map((path) => ({
  path: relative(SRC, path),
  text: readFileSync(path, 'utf8'),
}));
const withText = (pattern: RegExp) =>
  ALL.filter((file) => pattern.test(file.text))
    .map((file) => file.path)
    .sort();
const read = (path: string) => ALL.find((file) => file.path === path)?.text ?? '';

/**
 * docs/adr/0030: every path that sends tenant data to an external model or client goes through
 * the egress guard (contexts/privacy). These tests fail when a new path appears without it.
 */
describe('egress guard coverage', () => {
  it('the three external-AI adapters only accept sanitised payloads', () => {
    expect(read('contexts/analyst/infrastructure/claude-narrator.ts')).toMatch(
      /narrate\(briefing: SanitisedPayload<string>/,
    );
    expect(read('contexts/intelligence/infrastructure/ollama-embeddings.ts')).toMatch(
      /embed\(text: SanitisedPayload<string>/,
    );
    expect(read('contexts/integration/http/mcp-tools.ts')).toMatch(
      /readonly data: SanitisedPayload<unknown>/,
    );
    expect(read('contexts/analyst/application/ports.ts')).toMatch(
      /narrate\(briefing: SanitisedPayload<string>/,
    );
    expect(read('contexts/intelligence/application/ports.ts')).toMatch(
      /embed\(text: SanitisedPayload<string>/,
    );
    expect(read('contexts/ontology/application/ports.ts')).toMatch(
      /embed\(text: SanitisedPayload<string>/,
    );
  });

  it('only the Claude narrator talks to the Anthropic SDK', () => {
    expect(withText(/@anthropic-ai\/sdk/)).toEqual([
      'contexts/analyst/infrastructure/claude-narrator.ts',
    ]);
  });

  it('pins every module that makes outbound HTTP calls: a new one needs a decision', () => {
    // Embeddings and the narrators (the OpenAI-compatible one is the analyst's only outbound call
    // besides Claude's SDK) are guarded. The rest do not carry tenant records to an AI
    // service: object storage, Google sign-in, public feeds and registries, user-configured
    // automation channels (restricted content never leaves, ADR 0014) and Web Push.
    expect(withText(/typeof fetch|globalThis\.fetch|\?\? fetch\b|= fetch\b|\bfetch\(/)).toEqual([
      'contexts/analyst/infrastructure/openai-compatible-narrator.ts',
      'contexts/automation/infrastructure/http-channel-sender.ts',
      'contexts/automation/infrastructure/web-push.ts',
      'contexts/evidence/infrastructure/s3-object-storage.ts',
      'contexts/geography/infrastructure/index.ts',
      'contexts/identity/infrastructure/google-oidc.ts',
      'contexts/integration/infrastructure/official-source.ts',
      'contexts/integration/infrastructure/rss-feed-gateway.ts',
      'contexts/intelligence/infrastructure/ollama-embeddings.ts',
    ]);
  });

  it('nobody forges a sanitised payload outside the guard', () => {
    expect(withText(/as (unknown as )?SanitisedPayload/)).toEqual([
      'contexts/privacy/application/egress-guard.ts',
      'contexts/privacy/domain/sanitised.ts',
    ]);
    // The only constructor that does not sanitise: constants, a write's own id, loopback text.
    expect(withText(/\bexemptPayload\(/)).toEqual([
      'contexts/integration/http/mcp-tools.ts',
      'contexts/intelligence/application/intelligence-service.ts',
      'contexts/ontology/application/ontology-service.ts',
    ]);
    // Sealing is the guard's alone.
    expect(withText(/\bsealPayload\(/)).toEqual(['contexts/privacy/application/egress-guard.ts']);
  });

  it('other contexts reach the guard only through its public API', () => {
    const offenders = ALL.filter(
      (file) =>
        !file.path.startsWith('contexts/privacy/') &&
        /contexts\/privacy\/(domain|infrastructure|http)|\.\.\/privacy\/(domain|infrastructure)/.test(
          file.text.replace(/\n/g, ' '),
        ) &&
        !file.path.startsWith('compose.ts'),
    ).map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it('every MCP tool is a guarded read, the static catalogue or a write', () => {
    expect(MCP_TOOLS.map((tool) => [tool.name, tool.kind])).toEqual([
      ['list_object_types', 'catalogue'],
      ['search_records', 'read'],
      ['get_record', 'read'],
      ['get_links', 'read'],
      ['get_timeline', 'read'],
      ['get_briefing', 'read'],
      ['create_record', 'write'],
      ['link_records', 'write'],
    ]);
  });
});
