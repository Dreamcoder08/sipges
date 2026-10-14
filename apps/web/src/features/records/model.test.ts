import { describe, expect, it } from 'vitest';
import { byOrigin, safePublicUrl } from './model.ts';

// Regression (functional audit, errors 01-02): demo rows are separated, never relabelled.
describe('byOrigin', () => {
  const rows = [
    { _id: 'D-1', Descripcion: 'Registrada por el equipo' },
    { _id: 'DEMO-D-03', Dato_Sintetico: true, Demo_Dataset: 'mascli-academic-v1' },
    { _id: 'X', Demo_Dataset: 'mascli-academic-v1' },
  ];
  it('keeps real and demo records apart by their stored markers', () => {
    expect(byOrigin(rows, 'real').map((r) => r._id)).toEqual(['D-1']);
    expect(byOrigin(rows, 'demo').map((r) => r._id)).toEqual(['DEMO-D-03', 'X']);
    expect(byOrigin(rows, 'todos')).toHaveLength(3);
  });
});

describe('safePublicUrl', () => {
  it('rejects reserved .invalid hosts', () => {
    expect(safePublicUrl('https://example.invalid/mascli/1')).toBeNull();
    expect(safePublicUrl('https://example.org/x')).toBe('https://example.org/x');
  });
});
