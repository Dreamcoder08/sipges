import {
  type LinkCreated,
  type LinkEdge,
  LinkIn,
  type ObjectSummary as ObjectSummaryOut,
  type OntologyCatalog,
  type RecordGraph,
  type RecordLinks,
} from '@mascli/contracts';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { AppEnv } from '../../../platform/http/env.ts';
import { isoSeconds } from '../../../platform/http/time.ts';
import { parseIntQuery, parseJson } from '../../../platform/http/validation.ts';
import { formatScope } from '../../tenancy/application/index.ts';
import type { Edge, ObjectSummary, OntologyService } from '../application/index.ts';

const MISSING_RECORD = { detail: 'Registro no encontrado' };
const LINK_ERRORS = {
  unknown_type: [422, 'Tipo de vínculo no válido'],
  unknown_object: [422, 'Tipo de objeto no válido'],
  self_link: [422, 'Un registro no puede vincularse consigo mismo'],
  not_allowed: [422, 'El tipo de vínculo no admite esos tipos de objeto'],
  missing: [404, 'Registro no encontrado'],
  duplicate: [409, 'El vínculo ya existe'],
} as const;

const tenantOf = (c: Context<AppEnv>) => formatScope(c.get('scope'));

export const summaryOut = (summary: ObjectSummary): ObjectSummaryOut => ({
  module: summary.slug,
  id: summary.id,
  type_label: summary.typeLabel,
  title: summary.title,
  date: summary.date,
  fields: { ...summary.fields },
});

const edgeOut = (edge: Edge): LinkEdge => ({
  id: edge.id,
  link_type: edge.linkType,
  source: { module: edge.source.slug, id: edge.source.id },
  target: { module: edge.target.slug, id: edge.target.id },
  inferred: edge.inferred,
  via: edge.via,
  note: edge.note,
  created_by: edge.createdBy,
  created_at: edge.createdAt ? isoSeconds(edge.createdAt) : null,
});

const recordQuery = (c: Context<AppEnv>) => ({
  module: c.req.query('module') ?? '',
  id: c.req.query('id') ?? '',
});

/** Ontology catalog, typed links and link analysis (docs/adr/0011). */
export const ontologyRoutes = (ontology: OntologyService) =>
  new Hono<AppEnv>()
    .get('/system/ontology', (c) => {
      const { objectTypes, linkTypes } = ontology.catalog();
      return c.json({
        object_types: objectTypes.map((t) => ({
          module: t.slug,
          label: t.label,
          title_field: t.titleField,
          summary_fields: [...t.summaryFields],
          date_field: t.dateField,
        })),
        link_types: linkTypes.map((t) => ({
          id: t.id,
          label: t.label,
          inverse_label: t.inverseLabel,
          sources: t.sources ? [...t.sources] : null,
          targets: t.targets ? [...t.targets] : null,
          symmetric: t.symmetric,
        })),
      } satisfies OntologyCatalog);
    })

    .get('/system/links', async (c) => {
      const { module, id } = recordQuery(c);
      const found = await ontology.neighbours(tenantOf(c), module, id);
      if (!found) return c.json(MISSING_RECORD, 404);
      return c.json({
        record: summaryOut(found.record),
        links: found.neighbours.map((n) => ({
          edge: edgeOut(n.edge),
          direction: n.direction,
          label: n.label,
          other: summaryOut(n.other),
        })),
      } satisfies RecordLinks);
    })

    .post('/system/links', async (c) => {
      const body = await parseJson(c, LinkIn);
      if (!body.ok) return body.response;
      const created = await ontology.link(
        tenantOf(c),
        {
          linkType: body.value.link_type,
          source: { slug: body.value.source.module, id: body.value.source.id },
          target: { slug: body.value.target.module, id: body.value.target.id },
          note: body.value.note,
        },
        c.get('identity').username,
      );
      if (!created.ok) {
        const [status, detail] = LINK_ERRORS[created.error];
        return c.json({ detail }, status);
      }
      return c.json({ ok: true, id: created.value } satisfies LinkCreated);
    })

    .delete('/system/links/:id', async (c) => {
      const raw = c.req.param('id');
      const id = /^\d{1,9}$/.test(raw) ? Number(raw) : null;
      const removed = id !== null && (await ontology.unlink(tenantOf(c), id));
      return removed ? c.json({ ok: true }) : c.json({ detail: 'Vínculo no encontrado' }, 404);
    })

    .get('/system/graph', async (c) => {
      const { module, id } = recordQuery(c);
      const depth = parseIntQuery(c, 'depth', 1);
      if (!depth.ok) return depth.response;
      const graph = await ontology.graph(tenantOf(c), module, id, depth.value);
      if (!graph) return c.json(MISSING_RECORD, 404);
      return c.json({
        root: { module: graph.root.slug, id: graph.root.id },
        nodes: graph.nodes.map(summaryOut),
        edges: graph.edges.map(edgeOut),
        truncated: graph.truncated,
      } satisfies RecordGraph);
    });
