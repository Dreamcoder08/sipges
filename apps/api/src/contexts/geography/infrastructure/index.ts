import {
  type GeographyCatalogue,
  GeographyServiceId,
  type GeographyQuery,
} from '@sipges/contracts';
const ORIGIN = 'https://geocatmin.ingemmet.gob.pe/arcgis/rest/services/';
export const officialServiceUrl = (id: string) =>
  `${ORIGIN}${GeographyServiceId.parse(id)}/MapServer`;
/** Fixed official destinations. TLS validation remains enabled; redirects are rejected. */
export const createIngemmetGateway = (
  options: { fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {},
) => {
  const fetcher = options.fetch ?? fetch;
  const json = async (url: string) => {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
    try {
      const response = await fetcher(url, {
        redirect: 'error',
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`INGEMMET HTTP ${response.status}`);
      const limit = options.maxBytes ?? 2_000_000;
      if (Number(response.headers.get('content-length')) > limit)
        throw new Error('INGEMMET excede el límite de respuesta');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Respuesta oficial vacía');
      let size = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel();
          throw new Error('INGEMMET excede el límite de respuesta');
        }
        chunks.push(value);
      }
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
      }
      const data = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
      if (data['error']) throw new Error('INGEMMET rechazó la consulta');
      return data;
    } finally {
      clearTimeout(timer);
    }
  };
  // Only a settled catalogue is shared. On Workers a lookup still in flight belongs to the request
  // that started it: if that request is cancelled it never settles, and a caller awaiting it would
  // hang. Concurrent cold callers repeat the lookup, which is cheaper than that wait.
  let cached: { expires: number; data: GeographyCatalogue } | undefined;
  const catalogue = async (): Promise<GeographyCatalogue> => {
    if (cached && cached.expires > Date.now()) return cached.data;
    const layers: GeographyCatalogue['layers'] = [],
      services: GeographyCatalogue['services'] = [],
      checkedAt = new Date().toISOString();
    const ids = [...GeographyServiceId.options];
    for (let i = 0; i < ids.length; i += 2)
      await Promise.all(
        ids.slice(i, i + 2).map(async (id) => {
          try {
            const base = officialServiceUrl(id),
              data = await json(`${base}/layers?f=json`),
              root = await json(`${base}?f=json`);
            if (!Array.isArray(data['layers'])) throw new Error('Catálogo oficial inválido');
            for (const raw of data['layers']) {
              if (!raw || typeof raw !== 'object') continue;
              const l = raw as Record<string, unknown>;
              if (
                l['type'] !== 'Feature Layer' ||
                !Number.isInteger(l['id']) ||
                typeof l['name'] !== 'string'
              )
                continue;
              layers.push({
                serviceId: id,
                id: l['id'] as number,
                name: l['name'],
                minScale: typeof l['minScale'] === 'number' ? l['minScale'] : null,
                maxScale: typeof l['maxScale'] === 'number' ? l['maxScale'] : null,
                capabilities:
                  typeof l['capabilities'] === 'string'
                    ? l['capabilities']
                    : String(root['capabilities'] ?? ''),
                attribution: String(l['copyrightText'] || root['copyrightText'] || 'INGEMMET'),
                exportUrl: `${base}/export`,
                metadataUrl: `${base}/${l['id']}`,
              });
            }
            services.push({ id, status: 'verified', checkedAt });
          } catch {
            services.push({
              id,
              status: 'unavailable',
              checkedAt,
              error:
                'No se pudo verificar el servicio oficial. Revise INGEMMET; no se inventan capas ni escalas.',
            });
          }
        }),
      );
    const data: GeographyCatalogue = {
      status: services.some((s) => s.status === 'verified') ? 'verified' : 'unavailable',
      checkedAt,
      serviceUrl: ORIGIN,
      attribution: 'INGEMMET – GEOCATMIN',
      services,
      layers,
      ...(layers.length ? {} : { error: 'No fue posible verificar el catálogo oficial.' }),
    };
    cached = { expires: Date.now() + (layers.length ? 300_000 : 30_000), data };
    return data;
  };
  return {
    catalogue,
    async query(input: GeographyQuery) {
      const cat = await catalogue(),
        layer = cat.layers.find(
          (l) =>
            l.serviceId === input.serviceId &&
            l.id === input.layerId &&
            l.capabilities.includes('Query'),
        );
      if (!layer) throw new Error('Capa no verificable o sin capacidad de consulta');
      const params = new URLSearchParams({
        f: 'json',
        where: '1=1',
        outFields: '*',
        returnGeometry: 'true',
        outSR: '4326',
        inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects',
        resultRecordCount: '200',
        geometryType: input.polygon ? 'esriGeometryPolygon' : 'esriGeometryEnvelope',
        geometry: JSON.stringify(
          input.polygon
            ? {
                rings: input.polygon.coordinates.map((ring, index) => {
                  const area = ring.slice(1).reduce((sum, p, i) => {
                    const prev = ring[i];
                    return prev ? sum + prev[0] * p[1] - p[0] * prev[1] : sum;
                  }, 0);
                  return (index === 0 ? area > 0 : area < 0) ? [...ring].reverse() : ring;
                }),
                spatialReference: { wkid: 4326 },
              }
            : {
                xmin: input.bbox?.[0],
                ymin: input.bbox?.[1],
                xmax: input.bbox?.[2],
                ymax: input.bbox?.[3],
                spatialReference: { wkid: 4326 },
              },
        ),
      });
      const data = await json(
        `${officialServiceUrl(input.serviceId)}/${input.layerId}/query?${params}`,
      );
      if (!Array.isArray(data['features']))
        throw new Error('Respuesta geográfica oficial inválida');
      return {
        features: data['features'].slice(0, 200).map((f: unknown) => {
          const feature = f as Record<string, unknown>;
          return {
            attributes: feature['attributes'] as Record<string, unknown>,
            geometry: feature['geometry'],
          };
        }),
        truncated: data['exceededTransferLimit'] === true || data['features'].length >= 200,
        source: layer.metadataUrl,
      };
    },
  };
};
export type IngemmetGateway = ReturnType<typeof createIngemmetGateway>;
