import { currentRequestContext } from '../request-context.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Readonly<Record<string, unknown>>;

const SINKS: Record<LogLevel, (line: string) => void> = {
  debug: (line) => console.log(line),
  info: (line) => console.info(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};

const serializeError = (error: unknown) =>
  error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { message: String(error) };

/**
 * One JSON object per line (12-factor logs), tagged with the current request id and actor so
 * a log aggregator can follow a request end to end. Never log payloads, cookies or secrets.
 */
export const log = (level: LogLevel, message: string, fields: LogFields = {}) => {
  const context = currentRequestContext();
  const entry: Record<string, unknown> = {
    time: new Date().toISOString(),
    level,
    msg: message,
    ...(context ? { request_id: context.requestId } : {}),
    ...(context?.trace ? { trace_id: context.trace.traceId, span_id: context.trace.spanId } : {}),
    ...(context?.actor ? { actor: context.actor } : {}),
    ...fields,
  };
  if (fields['error'] !== undefined) entry['error'] = serializeError(fields['error']);
  SINKS[level](JSON.stringify(entry));
};
