import { type WebAssets, webAssetsFrom } from '../../api/src/platform/http/spa.ts';
import type { AssetFetcher } from './bindings.ts';

/** The built SPA from Workers Static Assets; names are validated by webAssetsFrom first. */
export const workerWebAssets = (assets: AssetFetcher): WebAssets =>
  webAssetsFrom(async (relativePath) => {
    const response = await assets.fetch(new Request(`https://assets.invalid/${relativePath}`));
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
  });
