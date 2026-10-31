// Bundled in place of @node-rs/argon2, a native addon workerd cannot load. The adapter
// injects the plain-JavaScript hasher, so this module only fails loudly if that wiring breaks.
const unavailable = () => {
  throw new Error('Native Argon2 is not available on Cloudflare Workers');
};
export const hash = unavailable;
export const verify = unavailable;
