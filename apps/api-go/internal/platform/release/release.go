// Package release names the SIPGES release this build belongs to (odd/archive/functional-10.md
// T8). The version has one source, the root package.json; TypeScript reads the same value from
// SIPGES_VERSION in packages/contracts/src/health.ts, and a test on each side pins it there.
package release

// Version is the root package.json "version". /health and the model status report it; the IRSA
// method version (config_version, «Método IRSA v0.4») is separate and never this one.
const Version = "1.1.0"
