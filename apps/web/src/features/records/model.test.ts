import { describe, expect, it } from 'vitest';
import { isCompactField, safePublicUrl } from './model.ts';
import { MODULES } from './modules.ts';

describe('isCompactField', () => {
  const field = (key: string) =>
    MODULES.directorio.fields.find((f) => f.key === key) ?? { key, label: key };
  it('keeps phones and short choices on one line, lets long text wrap', () => {
    expect(isCompactField(field('Telefono'))).toBe(true);
    expect(isCompactField(field('Prioridad'))).toBe(true);
    expect(isCompactField(field('Institucion'))).toBe(false);
  });
});

describe('safePublicUrl', () => {
  it('rejects reserved .invalid hosts', () => {
    expect(safePublicUrl('https://example.invalid/mascli/1')).toBeNull();
    expect(safePublicUrl('https://example.org/x')).toBe('https://example.org/x');
  });
});
