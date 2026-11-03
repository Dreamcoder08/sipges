/**
 * The few Cloudflare runtime shapes this adapter uses, declared structurally so the
 * workspace does not depend on @cloudflare/workers-types.
 */
export type Hyperdrive = { readonly connectionString: string };

export type R2ObjectBody = { arrayBuffer(): Promise<ArrayBuffer> };

export type R2Bucket = {
  put(
    key: string,
    value: Uint8Array,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
  delete(key: string): Promise<void>;
};

export type AssetFetcher = { fetch(request: Request): Promise<Response> };

export type ExecutionContext = { waitUntil(promise: Promise<unknown>): void };

/** The Durable Object namespace of the Go container (GoBackend), only in the `go` environment. */
export type GoBackendNamespace = {
  idFromName(name: string): unknown;
  get(
    id: unknown,
    options?: { locationHint?: string },
  ): { fetch(request: Request): Promise<Response> };
};

/** Bindings and variables declared in wrangler.jsonc; secrets arrive as strings too. */
export type Env = {
  readonly HYPERDRIVE: Hyperdrive;
  readonly EVIDENCE: R2Bucket;
  readonly ASSETS: AssetFetcher;
  readonly GO_BACKEND?: GoBackendNamespace;
} & Readonly<Record<string, unknown>>;
