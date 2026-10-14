import { Hono } from 'hono';
import type { AppEnv } from '../../../platform/http/env.ts';
import { log } from '../../../platform/observability/logger.ts';
import type { ApiKeyService } from '../application/index.ts';
import { authenticateKey } from './machine-auth.ts';
import { type ToolServices, runTool, toolDescriptor, toolsFor } from './mcp-tools.ts';

export const MCP_PATH = '/mcp';

/** Newest first; a client asking for another version gets the newest (MCP lifecycle). */
export const MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;

const SERVER_INFO = { name: 'mascli', title: 'MASCLI', version: '1.0.0' };
const INSTRUCTIONS =
  'MASCLI es una plataforma de gestión socioambiental territorial. Empieza con list_object_types, ' +
  'busca con search_records y profundiza con get_links, get_timeline y get_briefing. Cita los ' +
  'identificadores de los registros en tus respuestas.';

type JsonRpcId = string | number | null;
type Message = { jsonrpc?: unknown; id?: JsonRpcId; method?: unknown; params?: unknown };

const rpcError = (id: JsonRpcId, code: number, message: string) => ({
  jsonrpc: '2.0' as const,
  id,
  error: { code, message },
});
const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: '2.0' as const, id, result });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Stateless Streamable HTTP transport (docs/adr/0014 §7): each POST carries one JSON-RPC
 * message and gets a JSON answer; there is no session and no server-initiated stream.
 */
export const mcpRoutes = (deps: { keys: ApiKeyService; services: ToolServices }) =>
  new Hono<AppEnv>()
    .get(MCP_PATH, (c) => c.json({ detail: 'Use POST: este servidor MCP no abre flujos SSE' }, 405))
    .delete(MCP_PATH, (c) => c.json({ detail: 'Servidor MCP sin sesión' }, 405))
    .post(MCP_PATH, async (c) => {
      // DNS-rebinding guard from the MCP transport spec: a browser Origin must be this host.
      const origin = c.req.header('origin');
      if (origin && origin !== 'null') {
        let host: string;
        try {
          host = new URL(origin).host.toLowerCase();
        } catch {
          host = '';
        }
        if (host !== (c.req.header('host') ?? '').toLowerCase())
          return c.json({ detail: 'Origen de solicitud no permitido' }, 403);
      }
      const auth = await authenticateKey(c, deps.keys, { write: false });
      if (!auth.ok) return auth.response;

      let message: Message;
      try {
        message = (await c.req.json()) as Message;
      } catch {
        return c.json(rpcError(null, -32700, 'Parse error'), 400);
      }
      if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
        return c.json(
          rpcError(null, -32600, 'Invalid Request: one JSON-RPC 2.0 message per POST'),
          400,
        );
      }
      // Notifications and responses from the client need no answer.
      if (message.id === undefined) return c.body(null, 202);
      const id = message.id;
      const params = isRecord(message.params) ? message.params : {};

      switch (message.method) {
        case 'initialize': {
          const requested =
            typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
          const protocolVersion = (MCP_VERSIONS as readonly string[]).includes(requested)
            ? requested
            : MCP_VERSIONS[0];
          return c.json(
            rpcResult(id, {
              protocolVersion,
              capabilities: { tools: { listChanged: false } },
              serverInfo: SERVER_INFO,
              instructions: INSTRUCTIONS,
            }),
          );
        }
        case 'ping':
          return c.json(rpcResult(id, {}));
        case 'tools/list':
          return c.json(rpcResult(id, { tools: toolsFor(auth.principal).map(toolDescriptor) }));
        case 'tools/call': {
          const name = typeof params.name === 'string' ? params.name : '';
          const tool = toolsFor(auth.principal).find((t) => t.name === name);
          if (!tool) return c.json(rpcError(id, -32602, `Herramienta desconocida: ${name}`));
          const parsed = tool.input.safeParse(params.arguments ?? {});
          if (!parsed.success) {
            const detail = parsed.error.issues
              .map((issue) => `${issue.path.join('.') || 'argumentos'}: ${issue.message}`)
              .join('; ');
            return c.json(
              rpcResult(id, {
                content: [{ type: 'text', text: `Argumentos no válidos: ${detail}` }],
                isError: true,
              }),
            );
          }
          let outcome;
          try {
            outcome = await runTool(
              tool,
              deps.services,
              { principal: auth.principal, projectId: auth.projectId },
              parsed.data,
            );
          } catch (error) {
            log('error', 'mcp_tool_failed', { tool: name, error });
            return c.json(
              rpcResult(id, {
                content: [{ type: 'text', text: 'Error interno de MASCLI' }],
                isError: true,
              }),
            );
          }
          return c.json(
            rpcResult(
              id,
              outcome.ok
                ? {
                    content: [{ type: 'text', text: JSON.stringify(outcome.data) }],
                    structuredContent: isRecord(outcome.data)
                      ? outcome.data
                      : { result: outcome.data },
                    isError: false,
                  }
                : { content: [{ type: 'text', text: outcome.error }], isError: true },
            ),
          );
        }
        default:
          return c.json(rpcError(id, -32601, `Método no soportado: ${message.method}`));
      }
    });
