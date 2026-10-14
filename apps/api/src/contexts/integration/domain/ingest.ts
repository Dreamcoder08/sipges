/** Records one inbound webhook call may create (docs/adr/0014 §6). */
export const MAX_INGEST_RECORDS = 50;
/** Fields per record; a form or automation tool never needs more. */
const MAX_FIELDS = 200;
/** `Idempotency-Key` (or Standard Webhooks `webhook-id`): printable ASCII, no spaces. */
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,200}$/;

export type IngestPayload = Readonly<Record<string, unknown>>;

export type IngestProblem = { readonly index: number | null; readonly message: string };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Accepts the shapes automation tools send: one record object, an array of records, or
 * `{ "records": [...] }`. Returns the payloads, or the first problem with its position.
 */
export const ingestPayloads = (
  body: unknown,
): { ok: true; payloads: IngestPayload[] } | { ok: false; problem: IngestProblem } => {
  const list = Array.isArray(body)
    ? body
    : isPlainObject(body) && Array.isArray(body.records) && Object.keys(body).length === 1
      ? body.records
      : [body];
  if (list.length === 0) return { ok: false, problem: { index: null, message: 'Sin registros' } };
  if (list.length > MAX_INGEST_RECORDS) {
    return {
      ok: false,
      problem: { index: null, message: `Máximo ${MAX_INGEST_RECORDS} registros por llamada` },
    };
  }
  for (const [index, item] of list.entries()) {
    if (!isPlainObject(item)) {
      return { ok: false, problem: { index, message: 'Cada registro debe ser un objeto JSON' } };
    }
    const fields = Object.keys(item).length;
    if (fields === 0) return { ok: false, problem: { index, message: 'Registro vacío' } };
    if (fields > MAX_FIELDS) {
      return { ok: false, problem: { index, message: `Máximo ${MAX_FIELDS} campos` } };
    }
  }
  return { ok: true, payloads: list as IngestPayload[] };
};

/** Form posts (HTML forms, Google Forms relays) arrive as text fields; files are not records. */
export const formPayload = (form: Readonly<Record<string, unknown>>): IngestPayload =>
  Object.fromEntries(
    Object.entries(form).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );

export const idempotencyKey = (header: string | undefined): string | null | 'invalid' => {
  if (header === undefined || header === '') return null;
  return IDEMPOTENCY_KEY.test(header) ? header : 'invalid';
};
