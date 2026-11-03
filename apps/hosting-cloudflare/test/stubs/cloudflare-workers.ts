/**
 * Node stand-in for the `cloudflare:workers` runtime module, so Vitest can load the Worker
 * (which exports the Go container class). Only the base classes @cloudflare/containers extends.
 */
export class DurableObject {
  readonly ctx: unknown;
  readonly env: unknown;
  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}
export class WorkerEntrypoint extends DurableObject {}
