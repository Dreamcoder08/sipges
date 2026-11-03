import { Container } from "@cloudflare/containers";

import { isAuthorized } from "./auth.ts";

interface Env {
  SPIKE: DurableObjectNamespace<SpikeContainer>;
  DATABASE_URL?: string;
  DATABASE_URL_POOLED?: string;
  SPIKE_TOKEN?: string;
}

// One Go process, placed in ENAM by the container constraint in wrangler.jsonc.
export class SpikeContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "2m"; // short on purpose: cold starts are cheap to reproduce and idle time is not billed

  constructor(ctx: ConstructorParameters<typeof Container<Env>>[0], env: Env) {
    super(ctx, env);
    const vars: Record<string, string> = {};
    if (env.DATABASE_URL) vars.DATABASE_URL = env.DATABASE_URL;
    if (env.DATABASE_URL_POOLED) vars.DATABASE_URL_POOLED = env.DATABASE_URL_POOLED;
    this.envVars = vars;
  }
}

const json = (status: number, body: unknown, headers: HeadersInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

// The container is placed near its Durable Object, and the Durable Object near
// the first request unless hinted; "enam" keeps both away from the caller's edge.
const INSTANCE_NAME = "spike-enam";
const LOCATION_HINT: DurableObjectLocationHint = "enam";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const colo = String((request.cf as { colo?: string } | undefined)?.colo ?? "unknown");

    if (request.method !== "GET") {
      return json(405, { error: { code: "method_not_allowed" } });
    }
    if (pathname === "/worker") {
      // Baseline: the Worker alone, no container, to subtract client ↔ edge time.
      return json(200, { status: "ok", colo });
    }
    if (pathname === "/db-ping" && !isAuthorized(request.headers.get("authorization"), env.SPIKE_TOKEN, crypto.subtle.timingSafeEqual.bind(crypto.subtle))) {
      return json(401, { error: { code: "unauthorized" } });
    }
    if (pathname !== "/health" && pathname !== "/db-ping" && pathname !== "/egress") {
      return json(404, { error: { code: "not_found" } });
    }

    const started = Date.now();
    const stub = env.SPIKE.get(env.SPIKE.idFromName(INSTANCE_NAME), { locationHint: LOCATION_HINT });
    const upstream = await stub.fetch(request);
    const containerMs = Date.now() - started; // includes the container start on a cold request
    const response = new Response(upstream.body, upstream);
    response.headers.set("x-worker-colo", colo);
    response.headers.set("x-container-fetch-ms", String(containerMs));
    return response;
  },
} satisfies ExportedHandler<Env>;
