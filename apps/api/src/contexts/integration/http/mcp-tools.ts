import { z } from 'zod';
import type { AnalystService } from '../../analyst/application/index.ts';
import {
  LINK_TYPES,
  OBJECT_TYPES,
  type ObjectSummary,
  type OntologyService,
} from '../../ontology/application/index.ts';
import {
  type RecordsService,
  moduleForSlug,
  validatePayload,
} from '../../records/application/index.ts';
import { type ApiPrincipal, keyActor, payloadProject } from '../application/index.ts';

/** Services an MCP tool may call; all of them run inside the key's tenant transaction. */
export type ToolServices = {
  readonly ontology: OntologyService;
  readonly records: RecordsService;
  readonly analyst: AnalystService;
};

export type ToolCall = {
  readonly principal: ApiPrincipal;
  /** The key's project id, which a written payload may not contradict. */
  readonly projectId: string;
};

export type ToolResult =
  { readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly error: string };

type Tool<S extends z.ZodType> = {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly input: S;
  readonly write: boolean;
  run(services: ToolServices, call: ToolCall, input: z.infer<S>): Promise<ToolResult>;
};

const tool = <S extends z.ZodType>(definition: Tool<S>) => definition;

const Module = z
  .string()
  .max(40)
  .describe(`Tipo de objeto: ${OBJECT_TYPES.map((t) => t.slug).join(', ')}`);
const Id = z.string().min(1).max(200).describe('Identificador del registro, p. ej. A-12 o EV-3');
const Ref = z.object({ module: Module, id: Id });

const summary = (s: ObjectSummary) => ({
  module: s.slug,
  id: s.id,
  type: s.typeLabel,
  title: s.title,
  date: s.date,
  marking: s.marking,
  fields: s.fields,
});

const fail = (error: string): ToolResult => ({ ok: false, error });
const done = (data: unknown): ToolResult => ({ ok: true, data });

/**
 * MCP tools (docs/adr/0014 §7). Reads go through the same services as the web app, so row-level
 * security and classification markings decide what an agent sees; writes need a write key.
 */
export const MCP_TOOLS = [
  tool({
    name: 'list_object_types',
    title: 'Catálogo de la ontología',
    description:
      'Tipos de objeto (módulos) y tipos de vínculo del proyecto. Úsalo primero para saber qué módulos y vínculos existen.',
    input: z.object({}),
    write: false,
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
  tool({
    name: 'search_records',
    title: 'Buscar registros',
    description:
      'Búsqueda de texto completo en todos los registros del proyecto (actores, eventos, demandas, compromisos, alertas, fuentes…), ordenada por relevancia.',
    input: z.object({
      query: z.string().min(1).max(200).describe('Palabras o identificador a buscar'),
      modules: z.array(Module).max(20).optional().describe('Limitar a estos tipos de objeto'),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    write: false,
    run: async (s, call, input) => {
      const hits = await s.ontology.search(
        call.principal.tenantId,
        input.query,
        input.modules ?? null,
        input.limit,
      );
      return done({ hits: hits.map((h) => ({ ...summary(h), match: h.match })) });
    },
  }),
  tool({
    name: 'get_record',
    title: 'Leer un registro',
    description: 'Todos los campos de un registro y su clasificación.',
    input: Ref,
    write: false,
    run: async (s, call, input) => {
      const module = moduleForSlug(input.module);
      const found = module ? await s.records.get(call.principal.tenantId, module, input.id) : null;
      if (!module || !found) return fail('Registro no encontrado');
      const linked = await s.ontology.neighbours(call.principal.tenantId, input.module, input.id);
      return done({
        module: input.module,
        id: found.id,
        updated_at: found.updatedAt.toISOString(),
        marking: linked?.record.marking ?? null,
        payload: found.payload,
      });
    },
  }),
  tool({
    name: 'get_links',
    title: 'Vínculos de un registro',
    description:
      'Vista 360°: registros conectados (explícitos e inferidos) con el tipo de relación y su dirección.',
    input: Ref,
    write: false,
    run: async (s, call, input) => {
      const found = await s.ontology.neighbours(call.principal.tenantId, input.module, input.id);
      if (!found) return fail('Registro no encontrado');
      return done({
        record: summary(found.record),
        links: found.neighbours.map((n) => ({
          link_type: n.edge.linkType,
          label: n.label,
          direction: n.direction,
          inferred: n.edge.inferred,
          other: summary(n.other),
        })),
      });
    },
  }),
  tool({
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
    write: false,
    run: async (s, call, input) => {
      const timeline = await s.ontology.timeline(call.principal.tenantId, {
        from: input.from,
        to: input.to,
        slugs: input.modules ?? null,
        limit: input.limit,
      });
      if (!timeline) return fail('Fechas no válidas: use AAAA, AAAA-MM o AAAA-MM-DD');
      return done({
        from: timeline.from,
        to: timeline.to,
        truncated: timeline.truncated,
        entries: timeline.entries.map(summary),
      });
    },
  }),
  tool({
    name: 'get_briefing',
    title: 'Informe con citas',
    description:
      'Informe extractivo de un registro y su entorno con citas numeradas a los registros fuente y señales de atención.',
    input: Ref,
    write: false,
    run: async (s, call, input) => {
      const briefing = await s.analyst.briefing(call.principal.tenantId, input.module, input.id);
      if (!briefing) return fail('Registro no encontrado');
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
  tool({
    name: 'create_record',
    title: 'Crear registro',
    description:
      'Crea un registro en un módulo. Requiere una clave de escritura. Devuelve el id asignado.',
    input: z.object({
      module: Module,
      payload: z.record(z.string(), z.unknown()).describe('Campos del registro'),
    }),
    write: true,
    run: async (s, call, input) => {
      const module = moduleForSlug(input.module);
      if (!module) return fail('Módulo no válido');
      const project = payloadProject(input.payload);
      if (project && project !== call.projectId)
        return fail('No se permite escribir en otro proyecto');
      const problem = validatePayload(module, input.payload);
      if (problem) return fail(problem.message);
      const created = await s.records.create(call.principal.tenantId, module, input.payload);
      return created.ok
        ? done({ module: input.module, id: created.value })
        : fail('No se pudo asignar un id');
    },
  }),
  tool({
    name: 'link_records',
    title: 'Vincular registros',
    description: 'Crea un vínculo tipado entre dos registros. Requiere una clave de escritura.',
    input: z.object({
      link_type: z.string().max(40).describe('Id de un tipo de vínculo de list_object_types'),
      source: Ref,
      target: Ref,
      note: z.string().max(500).default(''),
    }),
    write: true,
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

/** Runs a tool whose input `safeParse` already checked against that tool's own schema. */
export const runTool = (
  t: McpTool,
  services: ToolServices,
  call: ToolCall,
  input: unknown,
): Promise<ToolResult> =>
  (t.run as (s: ToolServices, c: ToolCall, i: unknown) => Promise<ToolResult>)(
    services,
    call,
    input,
  );
