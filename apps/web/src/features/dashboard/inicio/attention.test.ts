import type { IrsaSummary } from '@sipges/contracts';
import { describe, expect, it } from 'vitest';
import { attentionItems } from './attention.ts';

const alert = (id: string) => ({ id, title: `Alerta ${id}`, date: '', level: 'Rojo' as const });
const noEvidence = { insufficient_data: true } as IrsaSummary;

describe('attentionItems', () => {
  it('never lists more than five rows, keeping the Bandeja decision first', () => {
    const items = attentionItems({
      alerts: ['A', 'B', 'C', 'D', 'E'].map(alert),
      digital: [{ status: 'Pendiente de verificación' }] as never,
      irsa: noEvidence,
    });
    expect(items.map((item) => item.key)).toEqual([
      'digital',
      'alerta:A',
      'alerta:B',
      'alerta:C',
      'alerta:D',
    ]);
  });

  it('adds nothing for decided digital alerts or an IRSA with evidence', () => {
    expect(
      attentionItems({
        alerts: [],
        digital: [{ status: 'Corroborado' }] as never,
        irsa: { insufficient_data: false } as IrsaSummary,
      }),
    ).toEqual([]);
  });
});
