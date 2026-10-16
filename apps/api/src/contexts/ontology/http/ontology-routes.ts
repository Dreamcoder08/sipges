import {
  type LinkCreated,
  type LinkEdge,
  LinkIn,
  LinkEvidenceIn,
  MarkingIn,
  type ObjectSummary as ObjectSummaryOut,
  type OntologyCatalog,
  type RecordGraph,
  type RecordLinks,
  type SearchResults,
  type Timeline,
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
  marking: summary.marking as ObjectSummaryOut['marking'],
  fields: { ...summary.fields },
});

const edgeOut = (edge: Edge) =>
  ({
    id: edge.id,
    link_type: edge.linkType,
    source: { module: edge.source.slug, id: edge.source.id },
    target: { module: edge.target.slug, id: edge.target.id },
    inferred: edge.inferred,
    via: edge.via,
    note: edge.note,
    created_by: edge.createdBy,
    created_at: edge.createdAt ? isoSeconds(edge.createdAt) : null,
    evidence: edge.evidence ? summaryOut(edge.evidence) : null,
    evidence_status: edge.evidenceStatus ?? 'undocumented',
  }) satisfies LinkEdge;

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

    .get('/system/search', async (c) => {
      const q = (c.req.query('q') ?? '').slice(0, 200);
      const limit = parseIntQuery(c, 'limit', 20);
      if (!limit.ok) return limit.response;
      const modules = c.req.query('modules');
      const hits = await ontology.search(
        tenantOf(c),
        q,
        modules ? modules.split(',').filter(Boolean) : null,
        limit.value,
      );
      return c.json({
        query: q,
        hits: hits.map((hit) => ({
          ...summaryOut(hit),
          match: hit.match,
          semantic: hit.semantic,
        })),
      } satisfies SearchResults);
    })

    .get('/system/timeline', async (c) => {
      const limit = parseIntQuery(c, 'limit', 200);
      if (!limit.ok) return limit.response;
      const modules = c.req.query('modules');
      const timeline = await ontology.timeline(tenantOf(c), {
        from: (c.req.query('from') ?? '').slice(0, 10),
        to: (c.req.query('to') ?? '').slice(0, 10),
        slugs: modules ? modules.split(',').filter(Boolean) : null,
        limit: limit.value,
      });
      if (!timeline)
        return c.json({ detail: 'Fechas no válidas: use AAAA, AAAA-MM o AAAA-MM-DD' }, 422);
      return c.json({
        from: timeline.from,
        to: timeline.to,
        entries: timeline.entries.map(summaryOut),
        truncated: timeline.truncated,
      } satisfies Timeline);
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
          evidence: body.value.evidence ?? null,
        },
        c.get('identity').username,
      );
      if (!created.ok) {
        const [status, detail] = LINK_ERRORS[created.error];
        return c.json({ detail }, status);
      }
      return c.json({ ok: true, id: created.value } satisfies LinkCreated);
    })

    .put('/system/links/:id/evidence', async (c) => {
      const body = await parseJson(c, LinkEvidenceIn);
      if (!body.ok) return body.response;
      const raw = c.req.param('id');
      const id = /^\d{1,9}$/.test(raw) ? Number(raw) : null;
      const updated =
        id !== null &&
        (await ontology.setLinkEvidence(tenantOf(c), id, body.value.evidence?.id ?? null));
      return updated ? c.json({ ok: true }) : c.json(MISSING_RECORD, 404);
    })

    .put('/system/marking', async (c) => {
      const body = await parseJson(c, MarkingIn);
      if (!body.ok) return body.response;
      const result = await ontology.classify(
        tenantOf(c),
        body.value.module,
        body.value.id,
        body.value.marking,
      );
      return result.ok ? c.json({ ok: true, marking: result.value }) : c.json(MISSING_RECORD, 404);
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
