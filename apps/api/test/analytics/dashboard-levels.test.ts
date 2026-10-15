import { expect, it } from 'vitest';
import { dashboardSummary } from '../../src/contexts/analytics/domain/dashboard.ts';

it('counts arbitrary stored level names without inherited object properties', () => {
  const summary = dashboardSummary({
    Alertas: ['__proto__', 'constructor', '__proto__'].map((Nivel, index) => ({
      id: String(index),
      payload: { Nivel },
    })),
  });
  expect(Object.hasOwn(summary.niveles, '__proto__')).toBe(true);
  expect(summary.niveles['__proto__']).toBe(2);
  expect(summary.niveles['constructor']).toBe(1);
});
