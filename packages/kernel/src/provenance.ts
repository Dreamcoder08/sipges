/**
 * Where a record comes from, read from markers already in its payload (no stored field is
 * added or changed). The synthetic academic case (`demo:seed`) marks every row with
 * `Dato_Sintetico: true`, `Demo_Dataset` and `Demo_ID`; anything else was entered, imported
 * or migrated by people and counts as a real record.
 */
export type RecordOrigin = 'real' | 'demo';
export const recordOrigin = (payload: Readonly<Record<string, unknown>>): RecordOrigin =>
  payload['Dato_Sintetico'] === true ||
  (typeof payload['Demo_Dataset'] === 'string' && payload['Demo_Dataset'] !== '')
    ? 'demo'
    : 'real';
export const isDemoRecord = (payload: Readonly<Record<string, unknown>>) =>
  recordOrigin(payload) === 'demo';
