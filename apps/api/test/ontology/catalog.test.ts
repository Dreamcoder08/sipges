import { describe, expect, it } from 'vitest';
import {
  INFERENCE_RULES,
  LINK_TYPES,
  OBJECT_TYPES,
  objectTypeForSlug,
} from '../../src/contexts/ontology/application/index.ts';
import { checkLink } from '../../src/contexts/ontology/domain/catalog.ts';
import { moduleForSlug } from '../../src/contexts/records/application/index.ts';

describe('ontology catalog', () => {
  it('maps every object type onto an existing records module', () => {
    for (const objectType of OBJECT_TYPES) {
      expect(moduleForSlug(objectType.slug)).toBe(objectType.module);
    }
    expect(new Set(OBJECT_TYPES.map((t) => t.slug)).size).toBe(OBJECT_TYPES.length);
  });

  it('only names known object types in link types and inference rules', () => {
    for (const linkType of LINK_TYPES) {
      for (const slug of [...(linkType.sources ?? []), ...(linkType.targets ?? [])]) {
        expect(objectTypeForSlug(slug), `${linkType.id}: ${slug}`).not.toBeNull();
      }
    }
    for (const rule of INFERENCE_RULES) {
      expect(objectTypeForSlug(rule.holder)).not.toBeNull();
      expect(objectTypeForSlug(rule.target)).not.toBeNull();
      const [source, target] = rule.holderIsSource
        ? [rule.holder, rule.target]
        : [rule.target, rule.holder];
      expect(
        checkLink(rule.linkType, { slug: source, id: 'a' }, { slug: target, id: 'b' }),
        `${rule.linkType} ${source}→${target}`,
      ).toBeNull();
    }
  });

  it('validates link endpoints against the link type', () => {
    const actor = { slug: 'actores', id: 'A-1' };
    const event = { slug: 'eventos', id: 'EV-1' };
    expect(checkLink('participa_en', actor, event)).toBeNull();
    expect(checkLink('participa_en', event, actor)).toBe('not_allowed');
    expect(checkLink('nope', actor, event)).toBe('unknown_type');
    expect(checkLink('participa_en', { slug: 'planetas', id: 'x' }, event)).toBe('unknown_object');
    expect(checkLink('aliado_de', actor, actor)).toBe('self_link');
    expect(checkLink('relacionado_con', event, actor)).toBeNull();
  });
});
