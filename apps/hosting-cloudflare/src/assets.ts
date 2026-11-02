import { type WebAssets, webAssetsFrom } from '../../api/src/platform/http/spa.ts';
import type { AssetFetcher } from './bindings.ts';

/**
 * The built SPA from Workers Static Assets; names are validated by webAssetsFrom first.
 * Bodies are streamed through, so a large bundle or Cesium file is never held in memory.
 */
export const workerWebAssets = (assets: AssetFetcher): WebAssets =>
  webAssetsFrom(async (relativePath) => {
    const response = await assets.fetch(new Request(`https://assets.invalid/${relativePath}`));
    // An empty build file has no body; it is still a file, served as zero bytes.
    if (response.ok) return response.body ?? new Uint8Array();
    await response.body?.cancel();
    return null;
  });
