import type { Context } from 'hono';
import type { z } from 'zod';

/** One FastAPI/pydantic-style validation error item (docs/adr/0007). */
export type ValidationIssue = { type: string; loc: (string | number)[]; msg: string };

const toIssues = (error: z.ZodError, input: unknown): ValidationIssue[] =>
  error.issues.map((issue) => {
    const missing =
      issue.code === 'invalid_type' &&
      issue.path.length > 0 &&
      (typeof input !== 'object' || input === null || !(String(issue.path[0]) in input));
    return {
      type: missing ? 'missing' : issue.code,
      loc: ['body', ...issue.path.map((p) => (typeof p === 'number' ? p : String(p)))],
      msg: missing ? 'Field required' : issue.message,
    };
  });

export type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response };

const invalid = (c: Context, detail: ValidationIssue[]): Parsed<never> => ({
  ok: false,
  response: c.json({ detail }, 422),
});

/** Parses an urlencoded or multipart form (FastAPI `Form(...)`). */
export const parseForm = async <S extends z.ZodType>(
  c: Context,
  schema: S,
): Promise<Parsed<z.infer<S>>> => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.parseBody();
  } catch {
    return invalid(c, [{ type: 'value_error', loc: ['body'], msg: 'Invalid form body' }]);
  }
  const fields = Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === 'string'));
  const result = schema.safeParse(fields);
  return result.success
    ? { ok: true, value: result.data }
    : invalid(c, toIssues(result.error, fields));
};

/** Parses a JSON body (FastAPI pydantic model). */
export const parseJson = async <S extends z.ZodType>(
  c: Context,
  schema: S,
): Promise<Parsed<z.infer<S>>> => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return invalid(c, [{ type: 'json_invalid', loc: ['body'], msg: 'JSON decode error' }]);
  }
  const result = schema.safeParse(body);
  return result.success
    ? { ok: true, value: result.data }
    : invalid(c, toIssues(result.error, body));
};
