import { type WebAssets, webAssetsFrom } from '../../api/src/platform/http/spa.ts';
import type { AssetFetcher } from './bindings.ts';

/**
 * The built SPA from Workers Static Assets; names are validated by webAssetsFrom first.
 * Bodies are streamed through, so a large bundle or Cesium file is never held in memory.
 */
export const workerWebAssets = (assets: AssetFetcher): WebAssets =>
  webAssetsFrom(async (relativePath) => {
    const response = await assets.fetch(new Request(`https://assets.invalid/${relativePath}`));
    if (response.ok && response.body) return response.body;
    await response.body?.cancel();
    return null;
  });
