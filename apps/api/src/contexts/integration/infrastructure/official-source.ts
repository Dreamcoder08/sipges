import { z } from 'zod';
import type { OfficialSourceGateway } from '../application/authorized-sources.ts';
const HOST = 'www.defensoria.gob.pe';
const BASE = `https://${HOST}/wp-json/wp/v2/posts`;
const postSchema = z.object({
  id: z.number().int().positive().max(2147483647),
  link: z.string(),
  date_gmt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/),
  title: z.object({ rendered: z.string().max(100000) }),
  excerpt: z.object({ rendered: z.string().max(100000) }),
});
const plain = (value: string) =>
  value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
      const entities: Record<string, string> = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
        nbsp: ' ',
      };
      if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? match;
      const code = entity.toLowerCase().startsWith('#x')
        ? parseInt(entity.slice(2), 16)
        : Number(entity.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/\s+/g, ' ')
    .trim();
export const createOfficialSourceGateway = (
  deps: { fetch?: typeof fetch } = {},
): OfficialSourceGateway => {
  const read = async (params: URLSearchParams) => {
    params.set('_fields', 'id,link,date_gmt,title,excerpt');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await (deps.fetch ?? fetch)(`${BASE}?${params}`, {
        redirect: 'error',
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error('source_unavailable');
      if (Number(response.headers.get('content-length')) > 512 * 1024) {
        await response.body?.cancel();
        throw new Error('source_response_too_large');
      }
      if (!response.body) throw new Error('source_invalid_data');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 512 * 1024) {
          await reader.cancel();
          throw new Error('source_response_too_large');
        }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const rows = z
        .array(postSchema)
        .max(10)
        .safeParse(JSON.parse(new TextDecoder().decode(bytes)));
      if (!rows.success) throw new Error('source_invalid_data');
      return rows.data.map((row) => {
        const url = new URL(row.link);
        const date = new Date(`${row.date_gmt}Z`);
        if (
          !row.link.startsWith(`https://${HOST}/`) ||
          url.protocol !== 'https:' ||
          url.hostname !== HOST ||
          url.port ||
          url.username ||
          url.password ||
          !Number.isFinite(date.getTime()) ||
          date.toISOString().slice(0, 19) !== row.date_gmt
        )
          throw new Error('source_invalid_data');
        return {
          id: row.id,
          url: url.href,
          title: plain(row.title.rendered).slice(0, 500),
          excerpt: plain(row.excerpt.rendered).slice(0, 1500),
          published_at: date.toISOString(),
        };
      });
    } catch (error) {
      if (error instanceof Error && /^source_[a-z_]+$/.test(error.message)) throw error;
      throw new Error(controller.signal.aborted ? 'source_timeout' : 'source_invalid_data', {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    preview: (query) => {
      if (query.length > 100 || query.includes('\0'))
        return Promise.reject(new Error('source_invalid_query'));
      return read(new URLSearchParams({ per_page: '10', search: query }));
    },
    get: async (id) => {
      if (!Number.isInteger(id) || id <= 0 || id > 2147483647) throw new Error('source_invalid_id');
      const rows = await read(new URLSearchParams({ include: String(id), per_page: '1' }));
      const post = rows.find((row) => row.id === id);
      if (!post) throw new Error('source_not_found');
      return post;
    },
  };
};
