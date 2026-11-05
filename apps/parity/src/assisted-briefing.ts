import { REQUEST_TIMEOUT_MS, send } from './request.ts';
import type { ParityCase } from './types.ts';

/**
 * Assisted briefing (T51), in the second stage of the run, with the narrator pointing at the local
 * double. The same subjects run with the project's external AI switch off and then on; with it on
 * both APIs must send the double the same bytes, so what leaves through the guard is compared too.
 */
const SUBJECTS = [
  'module=actores&id=PARITY-AN-A1',
  'module=actores&id=PARITY-AN-A2',
  'module=eventos&id=PARITY-AN-EV1',
  'module=fuentes&id=PARITY-AN-F1',
  'module=fuentes&id=PARITY-AN-F2',
  'module=alertas&id=PARITY-AN-AL1',
  'module=demandas&id=PARITY-AN-D1',
];

export const assistedBriefingCases = (label: string): readonly ParityCase[] => [
  ...SUBJECTS.map((query): ParityCase => ({
    name: `assisted briefing ${label}: ${query}`,
    method: 'GET',
    path: `/system/briefing?${query}`,
    auth: 'admin',
    normalize: ['generated_at'],
  })),
  {
    name: `assisted briefing ${label}: read-only role`,
    method: 'GET',
    path: `/system/briefing?${SUBJECTS[0]}`,
    auth: 'consulta',
    normalize: ['generated_at'],
  },
  {
    name: `assisted briefing ${label}: unknown record`,
    method: 'GET',
    path: '/system/briefing?module=actores&id=PARITY-AN-NADA',
    auth: 'admin',
  },
];

export const setExternalAi = async (url: string, session: string, enabled: boolean) => {
  const change: ParityCase = {
    name: 'external AI switch',
    method: 'PUT',
    path: '/system/v4/settings',
    auth: 'admin',
    sameOrigin: true,
    body: { json: { external_ai: { enabled } } },
  };
  const { status } = await send(url, change, session, REQUEST_TIMEOUT_MS, 'ts');
  if (status !== 200) throw new Error(`the switch answered ${status}`);
};

/** Each narrated briefing must have arrived twice, once from each API, byte for byte. */
export const unpairedNarrations = (bodies: readonly string[]) => {
  const count = new Map<string, number>();
  for (const body of bodies) count.set(body, (count.get(body) ?? 0) + 1);
  return [...count.values()].filter((n) => n % 2 !== 0).length;
};
