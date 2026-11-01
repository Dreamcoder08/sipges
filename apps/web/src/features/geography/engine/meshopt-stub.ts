const unavailable = () => {
  throw new Error('La compresión meshopt no está disponible en SIPGES.');
};

/**
 * Stand-in for `meshoptimizer`, which CesiumJS imports only for compressed glTF and 3D Tiles
 * terrain, neither of which SIPGES loads. The real module compiles WebAssembly as soon as it is
 * imported, which the strict CSP (no `wasm-unsafe-eval`) refuses, so the web build aliases it
 * to this inert decoder (vite.config.ts, ADR 0026).
 */
export const MeshoptDecoder = {
  supported: false,
  ready: Promise.resolve(),
  decodeGltfBuffer: unavailable,
  decodeVertexBuffer: unavailable,
  decodeIndexBuffer: unavailable,
  decodeIndexSequence: unavailable,
};
