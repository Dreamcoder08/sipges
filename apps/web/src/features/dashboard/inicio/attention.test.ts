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

  // functional-10 T5 (F15): two open alerts with one title must not read as the same row.
  it('tells apart alerts with the same title by place and record id', () => {
    const items = attentionItems({
      alerts: [
        {
          id: 'AL-1',
          title: 'Registro de prueba 2',
          date: '2026-11-14',
          level: 'Rojo',
          place: 'Pampa Sintética',
        },
        {
          id: 'AL-2',
          title: 'Registro de prueba 2',
          date: '2026-11-14',
          level: 'Rojo',
          place: 'Pampa Sintética',
        },
        { id: 'AL-3', title: 'Corte sintético', date: '2026-11-13', level: 'Naranja', place: '' },
      ],
    });
    expect(items.map((item) => item.meta)).toEqual([
      'Alerta activa · 14 nov. · Pampa Sintética · AL-1',
      'Alerta activa · 14 nov. · Pampa Sintética · AL-2',
      'Alerta activa · 13 nov.',
    ]);
    expect(items.map((item) => item.label)).toEqual([
      'Abrir alerta Registro de prueba 2 · AL-1',
      'Abrir alerta Registro de prueba 2 · AL-2',
      'Abrir alerta Corte sintético',
    ]);
    expect(items.map((item) => item.action)).toEqual([
      'Abrir alerta',
      'Abrir alerta',
      'Abrir alerta',
    ]);
  });
});
