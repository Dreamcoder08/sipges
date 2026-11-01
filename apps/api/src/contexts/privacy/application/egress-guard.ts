import { currentRequestContext } from '../../../platform/request-context.ts';
import { log } from '../../../platform/observability/logger.ts';
import { createPseudonymiser } from '../domain/pseudonyms.ts';
import { type RawRecord, type SanitisedRecord, sanitiseRecords } from '../domain/sanitise.ts';
import { type SanitisedPayload, sealPayload } from '../domain/sanitised.ts';
import type { Clock, EgressLog, ExternalAiSwitch, NameDirectory, PseudonymKeys } from './ports.ts';

/** Where the data goes: the MCP server, the analyst narrator or an embeddings service. */
export type EgressChannel = 'mcp' | 'analyst' | 'embeddings';

export type EgressRequest = {
  /** `company/project`: the key and the known names are those of this project. */
  readonly tenantId: string;
  readonly channel: EgressChannel;
  /** The tool or purpose, e.g. `get_record` or `briefing`; goes to the access log. */
  readonly purpose: string;
  /** Who asked; defaults to the actor of the current request. */
  readonly actor?: string;
};

/** One release: records and text pass through it, then `release` logs and seals the payload. */
export type EgressSession = {
  /** Keeps allowed fields only, with names replaced by pseudonyms. */
  records(records: readonly RawRecord[]): SanitisedRecord[];
  /** Free text without contact data or any name the project knows. */
  text(value: string): string;
  /** Scrubs every string of `data`, writes the access log and seals the payload (once). */
  release<T>(data: T): Promise<SanitisedPayload<T>>;
  /** Like `release` for several payloads that travel separately but are logged as one. */
  releaseMany<T>(items: readonly T[]): Promise<SanitisedPayload<T>[]>;
};

export type OpenResult =
  | { readonly ok: true; readonly session: EgressSession }
  | { readonly ok: false; readonly reason: 'disabled' };

export type EgressGuard = {
  /** Refuses with `disabled` unless the project switched external AI on. */
  open(request: EgressRequest): Promise<OpenResult>;
};

/** Message every refusing path shows. */
export const EXTERNAL_AI_DISABLED = 'El envío a IA externa está desactivado para este proyecto';

const MAX_LOGGED_RECORDS = 100;
const MAX_LOGGED_FIELDS = 20;

/**
 * Cleared without sanitising because it is not tenant data leaving: `constant` is text written
 * in the code, `acknowledgement` is the id a caller's own write was given, and `loopback` is
 * text for a model on this machine, which is not egress.
 */
export const exemptPayload = <T>(
  data: T,
  _reason: 'constant' | 'acknowledgement' | 'loopback',
): SanitisedPayload<T> => sealPayload(data);

const stringChars = (data: unknown): number => {
  if (typeof data === 'string') return Array.from(data).length;
  if (Array.isArray(data)) return data.reduce((sum: number, item) => sum + stringChars(item), 0);
  if (typeof data === 'object' && data !== null)
    return Object.values(data).reduce((sum: number, item) => sum + stringChars(item), 0);
  return 0;
};

/** Every string leaf through `map`; plain objects and arrays are copied, the rest is kept. */
const mapStrings = (data: unknown, map: (text: string) => string): unknown => {
  if (typeof data === 'string') return map(data);
  if (Array.isArray(data)) return data.map((item) => mapStrings(item, map));
  if (typeof data === 'object' && data !== null && Object.getPrototypeOf(data) === Object.prototype)
    return Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, mapStrings(value, map)]),
    );
  return data;
};

/**
 * The single gate for tenant data bound for an external model or client (docs/adr/0030). It
 * refuses while the project's switch is off; otherwise it hands out a session whose output has
 * only allowlisted fields, pseudonyms instead of names and no contact data, and which writes
 * one access-log entry (ids and counts, never values) before anything is sealed.
 */
export const createEgressGuard = (deps: {
  switch: ExternalAiSwitch;
  names: NameDirectory;
  keys: PseudonymKeys;
  log: EgressLog;
  clock: Clock;
}): EgressGuard => ({
  async open(request) {
    if (!(await deps.switch.enabled(request.tenantId))) {
      log('info', 'external_ai_refused', { channel: request.channel, purpose: request.purpose });
      return { ok: false, reason: 'disabled' };
    }
    const pseudonymiser = createPseudonymiser({
      mac: deps.keys.macFor(request.tenantId),
      names: await deps.names.load(request.tenantId),
    });
    const actor = request.actor ?? currentRequestContext()?.actor ?? 'sistema';
    const ids = new Set<string>();
    let sent = 0;
    let dropped = 0;
    const withheld = new Set<string>();
    const droppedFields = new Set<string>();
    let released = false;

    /** Scrubs, logs once and seals; an unlogged release never happens. */
    const finish = async <T>(items: readonly T[]): Promise<SanitisedPayload<T>[]> => {
      if (released) throw new Error('An egress session releases once');
      released = true;
      const clean = items.map((item) => mapStrings(item, pseudonymiser.scrub) as T);
      const shown = [...ids].slice(0, MAX_LOGGED_RECORDS).map((id) => pseudonymiser.scrub(id));
      const more = ids.size - shown.length;
      const fields = [...droppedFields]
        .slice(0, MAX_LOGGED_FIELDS)
        .map((field) => pseudonymiser.scrub(field).slice(0, 60));
      const kept = [...withheld].slice(0, MAX_LOGGED_RECORDS).map((id) => pseudonymiser.scrub(id));
      const detail = [
        `canal ${request.channel}`,
        request.purpose,
        `actor ${actor}`,
        `registros: ${shown.length ? shown.join(', ') : 'ninguno'}${more > 0 ? ` (+${more} más)` : ''}`,
        `campos enviados: ${sent}`,
        `descartados: ${dropped}${fields.length ? ` (${fields.join(', ')})` : ''}`,
        ...(kept.length ? [`retenidos: ${kept.join(', ')}`] : []),
        `caracteres: ${stringChars(clean)}`,
      ].join(' · ');
      await deps.log.append(request.tenantId, { detail, at: deps.clock.now() });
      return clean.map((item) => sealPayload(item));
    };

    const session: EgressSession = {
      records(records) {
        const out = sanitiseRecords(pseudonymiser, records);
        for (const id of out.report.records) ids.add(id);
        sent += out.report.sent;
        dropped += out.report.dropped;
        for (const id of out.report.withheld) withheld.add(id);
        for (const field of out.report.droppedFields) droppedFields.add(field);
        return out.records;
      },
      text: (value) => pseudonymiser.scrub(value),
      release: async <T>(data: T) => (await finish([data]))[0] as SanitisedPayload<T>,
      releaseMany: finish,
    };
    return { ok: true, session };
  },
});
