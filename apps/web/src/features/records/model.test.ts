import { describe, expect, it } from 'vitest';
import { presentText, safePublicUrl } from './model.ts';

describe('presentText', () => {
  it('hides internal seed prefixes without touching other text', () => {
    expect(presentText('DEMO-E-01')).toBe('E-01');
    expect(presentText('Ver DEMO-AL-03 y DEMO-F-10')).toBe('Ver AL-03 y F-10');
    expect(presentText('demo-fuente-02.pdf')).toBe('fuente-02.pdf');
    expect(presentText('Demostración pública')).toBe('Demostración pública');
  });
});

describe('safePublicUrl', () => {
  it('rejects reserved .invalid hosts', () => {
    expect(safePublicUrl('https://example.invalid/mascli/1')).toBeNull();
    expect(safePublicUrl('https://example.org/x')).toBe('https://example.org/x');
  });
});
