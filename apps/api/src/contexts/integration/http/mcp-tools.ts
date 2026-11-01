import { z } from 'zod';
import type { AnalystService } from '../../analyst/application/index.ts';
import {
  LINK_TYPES,
  OBJECT_TYPES,
  type ObjectSummary,
  type OntologyService,
} from '../../ontology/application/index.ts';
import {
  EXTERNAL_AI_DISABLED,
  type EgressGuard,
  type EgressSession,
  type RawRecord,
  type SanitisedPayload,
  type SanitisedRecord,
  exemptPayload,
} from '../../privacy/application/index.ts';
import { type RecordsService, moduleForSlug } from '../../records/application/index.ts';
import { type ApiPrincipal, keyActor, payloadProject } from '../application/index.ts';

/** Services an MCP tool may call; all of them run inside the key's tenant transaction. */
export type ToolServices = {
  readonly ontology: OntologyService;
  readonly records: RecordsService;
  readonly analyst: AnalystService;
  /** Every tool that reads tenant data goes through it (docs/adr/0030). */
  readonly guard: EgressGuard;
};

export type ToolCall = {
  readonly principal: ApiPrincipal;
  /** The key's project id, which a written payload may not contradict. */
  readonly projectId: string;
};

/** What a tool answers: the data only ever leaves as a payload the egress guard sealed. */
export type ToolResult =
  | { readonly ok: true; readonly data: SanitisedPayload<unknown> }
  | { readonly ok: false; readonly error: string };

/** What a handler returns before the guard has looked at it; only `runTool` seals it. */
type Outcome =
  { readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly error: string };

/** A read call also carries the session that sanitises and logs what the tool returns. */
type ReadCall = ToolCall & { readonly egress: EgressSession };

type Tool<S extends z.ZodType> = {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly input: S;
  readonly write: boolean;
};
type CatalogueTool<S extends z.ZodType> = Tool<S> & {
  /** Static catalogue: no tenant data. */
  readonly kind: 'catalogue';
  run(services: ToolServices, call: ToolCall, input: z.infer<S>): Promise<Outcome>;
};
type WriteTool<S extends z.ZodType> = Tool<S> & {
  /** Creates data; answers only with the id it assigned. */
  readonly kind: 'write';
  run(services: ToolServices, call: ToolCall, input: z.infer<S>): Promise<Outcome>;
};
type ReadTool<S extends z.ZodType> = Tool<S> & {
  /** Reads tenant data: refused while external AI is off, sanitised and logged otherwise. */
  readonly kind: 'read';
  run(services: ToolServices, call: ReadCall, input: z.infer<S>): Promise<Outcome>;
};

const catalogueTool = <S extends z.ZodType>(definition: Omit<CatalogueTool<S>, 'kind' | 'write'>) =>
  ({ ...definition, kind: 'catalogue', write: false }) as CatalogueTool<S>;
const readTool = <S extends z.ZodType>(definition: Omit<ReadTool<S>, 'kind' | 'write'>) =>
  ({ ...definition, kind: 'read', write: false }) as ReadTool<S>;
const writeTool = <S extends z.ZodType>(definition: Omit<WriteTool<S>, 'kind' | 'write'>) =>
  ({ ...definition, kind: 'write', write: true }) as WriteTool<S>;

const Module = z
  .string()
  .max(40)
  .describe(`Tipo de objeto: ${OBJECT_TYPES.map((t) => t.slug).join(', ')}`);
const Id = z.string().min(1).max(200).describe('Identificador del registro, p. ej. A-12 o EV-3');
const Ref = z.object({ module: Module, id: Id });

const key = (s: { slug: string; id: string }) => `${s.slug}\u0000${s.id}`;

const rawSummary = (s: ObjectSummary): RawRecord => ({
  module: s.slug,
  id: s.id,
  title: s.title,
  date: s.date,
  marking: s.marking,
  fields: s.fields,
});

const outSummary = (s: ObjectSummary, clean: SanitisedRecord | undefined) => ({
  module: s.slug,
  id: s.id,
  type: s.typeLabel,
  title: clean?.title ?? s.id,
  date: clean?.date ?? null,
  marking: s.marking,
  fields: clean?.fields ?? {},
});

/** Sanitises every distinct record once; the result is looked up by `summarise`. */
const sanitiseSummaries = (egress: EgressSession, list: readonly ObjectSummary[]) => {
  const distinct = [...new Map(list.map((s) => [key(s), s])).values()];
  const clean = egress.records(distinct.map(rawSummary));
  const withheld = new Set(distinct.filter((_, i) => clean[i]?.withheld).map(key));
  const byKey = new Map(distinct.map((s, i) => [key(s), outSummary(s, clean[i])]));
  const summarise = (s: ObjectSummary) => byKey.get(key(s)) ?? outSummary(s, undefined);
  /** The records the guard lets through: restricted ones are left out of every list. */
  const visible = <T extends ObjectSummary>(items: readonly T[]) =>
    items.filter((s) => !withheld.has(key(s)));
  return Object.assign(summarise, {
    visible,
    isWithheld: (s: ObjectSummary) => withheld.has(key(s)),
  });
};

const fail = (error: string): Outcome => ({ ok: false, error });
const done = (data: unknown): Outcome => ({ ok: true, data });

/**
 * MCP tools (docs/adr/0014 §7). Reads go through the same services as the web app, so row-level
 * security and classification markings decide what an agent sees; writes need a write key.
 */
export const MCP_TOOLS = [
  catalogueTool({
    name: 'list_object_types',
    title: 'Catálogo de la ontología',
    description:
      'Tipos de objeto (módulos) y tipos de vínculo del proyecto. Úsalo primero para saber qué módulos y vínculos existen.',
    input: z.object({}),
    run: async () =>
      done({
        object_types: OBJECT_TYPES.map((t) => ({
          module: t.slug,
          label: t.label,
          title_field: t.titleField,
          date_field: t.dateField,
        })),
        link_types: LINK_TYPES.map((t) => ({
          id: t.id,
          label: t.label,
          sources: t.sources,
          targets: t.targets,
        })),
      }),
  }),
  readTool({
    name: 'search_records',
    title: 'Buscar registros',
    description:
      'Búsqueda de texto completo en todos los registros del proyecto (actores, eventos, demandas, compromisos, alertas, fuentes…), ordenada por relevancia y, si la búsqueda semántica está activa, también por significado.',
    input: z.object({
      query: z.string().min(1).max(200).describe('Palabras o identificador a buscar'),
      modules: z.array(Module).max(20).optional().describe('Limitar a estos tipos de objeto'),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    run: async (s, call, input) => {
      const hits = await s.ontology.search(
        call.principal.tenantId,
        // What the agent typed may itself name someone; it only goes into the lexical search.
        input.query,
        input.modules ?? null,
        input.limit,
        // A hit must be explained by a field that may leave; otherwise it reveals what a dropped
        // field (a stance, a health note, a complainant) holds.
        call.egress.allows,
      );
      const summarise = sanitiseSummaries(call.egress, hits);
      // The matching excerpt is a field value too: it passes the same allowlist.
      const shown = summarise.visible(hits);
      const excerpts = shown.flatMap((h) => (h.match ? [{ hit: h, match: h.match }] : []));
      const cleanExcerpts = call.egress.records(
        excerpts.map(({ hit, match }) => ({
          module: hit.slug,
          id: hit.id,
          marking: hit.marking,
          fields: { [match.field]: match.excerpt },
        })),
      );
      const excerptOf = new Map(
        excerpts.map(({ hit, match }, i) => {
          const value = cleanExcerpts[i]?.fields[match.field];
          return [key(hit), value === undefined ? null : { field: match.field, excerpt: value }];
        }),
      );
      return done({
        hits: shown.map((h) => ({
          ...summarise(h),
          match: excerptOf.get(key(h)) ?? null,
          semantic: h.semantic,
        })),
      });
    },
  }),
  readTool({
    name: 'get_record',
    title: 'Leer un registro',
    description: 'Los campos permitidos de un registro y su clasificación.',
    input: Ref,
    run: async (s, call, input) => {
      const module = moduleForSlug(input.module);
      const found = module ? await s.records.get(call.principal.tenantId, module, input.id) : null;
      if (!module || !found) return fail('Registro no encontrado');
      const linked = await s.ontology.neighbours(call.principal.tenantId, input.module, input.id);
      const [clean] = call.egress.records([
        {
          module: input.module,
          id: found.id,
          // Without a marking the record is withheld, never guessed open.
          marking: linked?.record.marking ?? null,
          fields: found.payload,
        },
      ]);
      if (clean?.withheld) return done({ module: input.module, id: found.id, withheld: true });
      return done({
        module: input.module,
        id: found.id,
        updated_at: found.updatedAt.toISOString(),
        marking: linked?.record.marking ?? null,
        payload: clean?.fields ?? {},
      });
    },
  }),
  readTool({
    name: 'get_links',
    title: 'Vínculos de un registro',
    description:
      'Vista 360°: registros conectados (explícitos e inferidos) con el tipo de relación y su dirección.',
    input: Ref,
    run: async (s, call, input) => {
      const found = await s.ontology.neighbours(call.principal.tenantId, input.module, input.id);
      if (!found) return fail('Registro no encontrado');
      const summarise = sanitiseSummaries(call.egress, [
        found.record,
        ...found.neighbours.map((n) => n.other),
      ]);
      // A restricted record's links say who it touches: only a stub leaves, as in get_record.
      if (summarise.isWithheld(found.record))
        return done({ module: input.module, id: input.id, withheld: true });
      return done({
        record: summarise(found.record),
        links: found.neighbours
          .filter((n) => !summarise.isWithheld(n.other))
          .map((n) => ({
            link_type: n.edge.linkType,
            label: n.label,
            direction: n.direction,
            inferred: n.edge.inferred,
            other: summarise(n.other),
          })),
      });
    },
  }),
  readTool({
    name: 'get_timeline',
    title: 'Cronología',
    description: 'Registros fechados entre dos fechas, del más reciente al más antiguo.',
    input: z.object({
      from: z
        .string()
        .max(10)
        .default('')
        .describe('AAAA, AAAA-MM o AAAA-MM-DD; vacío = sin límite'),
      to: z.string().max(10).default(''),
      modules: z.array(Module).max(20).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }),
    run: async (s, call, input) => {
      const timeline = await s.ontology.timeline(call.principal.tenantId, {
        from: input.from,
        to: input.to,
        slugs: input.modules ?? null,
        limit: input.limit,
      });
      if (!timeline) return fail('Fechas no válidas: use AAAA, AAAA-MM o AAAA-MM-DD');
      const summarise = sanitiseSummaries(call.egress, timeline.entries);
      return done({
        from: timeline.from,
        to: timeline.to,
        truncated: timeline.truncated,
        entries: summarise.visible(timeline.entries).map(summarise),
      });
    },
  }),
  readTool({
    name: 'get_briefing',
    title: 'Informe con citas',
    description:
      'Informe extractivo de un registro y su entorno con citas numeradas a los registros fuente y señales de atención.',
    input: Ref,
    run: async (s, call, input) => {
      const briefing = await s.analyst.briefing(call.principal.tenantId, input.module, input.id, {
        session: call.egress,
      });
      if (!briefing) return fail('Registro no encontrado');
      if (briefing.withheld) return done({ module: input.module, id: input.id, withheld: true });
      return done({
        subject: {
          module: briefing.subject.slug,
          id: briefing.subject.id,
          title: briefing.subject.title,
        },
        engine: briefing.engine,
        sections: briefing.sections,
        narrative: briefing.narrative,
        sources: briefing.sources.map((src) => ({
          ref: src.ref,
          module: src.slug,
          id: src.id,
          title: src.title,
        })),
      });
    },
  }),
  writeTool({
    name: 'create_record',
    title: 'Crear registro',
    description:
      'Crea un registro en un módulo. Requiere una clave de escritura. Devuelve el id asignado.',
    input: z.object({
      module: Module,
      payload: z.record(z.string(), z.unknown()).describe('Campos del registro'),
    }),
    run: async (s, call, input) => {
      const module = moduleForSlug(input.module);
      if (!module) return fail('Módulo no válido');
      const project = payloadProject(input.payload);
      if (project && project !== call.projectId)
        return fail('No se permite escribir en otro proyecto');
      const created = await s.records.create(call.principal.tenantId, module, input.payload);
      if (created.ok) return done({ module: input.module, id: created.value });
      return fail(
        created.error.kind === 'invalid' ? created.error.message : 'No se pudo asignar un id',
      );
    },
  }),
  writeTool({
    name: 'link_records',
    title: 'Vincular registros',
    description: 'Crea un vínculo tipado entre dos registros. Requiere una clave de escritura.',
    input: z.object({
      link_type: z.string().max(40).describe('Id de un tipo de vínculo de list_object_types'),
      source: Ref,
      target: Ref,
      note: z.string().max(500).default(''),
    }),
    run: async (s, call, input) => {
      const created = await s.ontology.link(
        call.principal.tenantId,
        {
          linkType: input.link_type,
          source: { slug: input.source.module, id: input.source.id },
          target: { slug: input.target.module, id: input.target.id },
          note: input.note,
        },
        keyActor(call.principal),
      );
      return created.ok ? done({ id: created.value }) : fail(`Vínculo rechazado: ${created.error}`);
    },
  }),
] as const;

export type McpTool = (typeof MCP_TOOLS)[number];

/** The tools a key may see: write tools only for write keys. */
export const toolsFor = (principal: ApiPrincipal): readonly McpTool[] =>
  MCP_TOOLS.filter((t) => !t.write || principal.access === 'write');

export const toolDescriptor = (t: McpTool) => ({
  name: t.name,
  title: t.title,
  description: t.description,
  inputSchema: z.toJSONSchema(t.input, { io: 'input' }),
  annotations: { readOnlyHint: !t.write, destructiveHint: false, openWorldHint: false },
});

type AnyRun = (services: ToolServices, call: ToolCall, input: unknown) => Promise<Outcome>;

/**
 * Runs a tool whose input `safeParse` already checked against that tool's own schema. A read
 * tool is refused while the project keeps external AI off; otherwise its data is sanitised and
 * the release is logged before it can be returned. The catalogue and the write tools carry no
 * tenant data out: the catalogue is static and a write answers with the id it assigned.
 */
export const runTool = async (
  t: McpTool,
  services: ToolServices,
  call: ToolCall,
  input: unknown,
): Promise<ToolResult> => {
  if (t.kind !== 'read') {
    const outcome = await (t.run as AnyRun)(services, call, input);
    return outcome.ok
      ? {
          ok: true,
          data: exemptPayload(outcome.data, t.kind === 'write' ? 'acknowledgement' : 'constant'),
        }
      : outcome;
  }
  const opened = await services.guard.open({
    tenantId: call.principal.tenantId,
    channel: 'mcp',
    purpose: t.name,
    actor: `${keyActor(call.principal)} (clave ${call.principal.keyId})`,
  });
  if (!opened.ok) return { ok: false, error: EXTERNAL_AI_DISABLED };
  const outcome = await (t.run as AnyRun)(
    services,
    { ...call, egress: opened.session } as ReadCall,
    input,
  );
  // An error carries a fixed message, never a record's content.
  return outcome.ok ? { ok: true, data: await opened.session.release(outcome.data) } : outcome;
};
