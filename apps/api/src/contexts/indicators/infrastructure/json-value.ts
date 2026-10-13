/** Drivers return `json` columns parsed; tolerate a raw string as well. */
export const jsonValue = <T>(value: unknown): T =>
  (typeof value === 'string' ? JSON.parse(value) : value) as T;
