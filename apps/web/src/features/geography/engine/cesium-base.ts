/**
 * Where CesiumJS finds its workers and assets: copied from @cesium/engine into /cesium/ at build
 * time (vite.config.ts) and served from our origin, so the strict CSP needs no other host.
 */
(globalThis as { CESIUM_BASE_URL?: string }).CESIUM_BASE_URL = '/cesium/';
