/**
 * Hexagonal dependency rule (docs/adr/0002-hexagonal-architecture-and-bounded-contexts.md).
 * domain -> nothing outside domain and @mascli/kernel
 * application -> domain (+ kernel, contracts)
 * infrastructure/http -> inward only; never another context's internals
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'domain-is-pure',
      comment: 'Domain code may only depend on domain code and the shared kernel.',
      severity: 'error',
      from: { path: '^apps/api/src/contexts/[^/]+/domain/' },
      to: {
        pathNot: ['^apps/api/src/contexts/[^/]+/domain/', '^packages/kernel/'],
      },
    },
    {
      name: 'application-does-not-reach-outward',
      comment: 'Use cases depend on ports, never on adapters or HTTP.',
      severity: 'error',
      from: { path: '^apps/api/src/contexts/[^/]+/application/' },
      to: { path: '^apps/api/src/contexts/[^/]+/(infrastructure|http)/' },
    },
    {
      name: 'contexts-are-isolated',
      comment:
        'A context may use another context only through its application/index.ts public API.',
      severity: 'error',
      from: { path: '^apps/api/src/contexts/([^/]+)/' },
      to: {
        path: '^apps/api/src/contexts/([^/]+)/',
        pathNot: [
          '^apps/api/src/contexts/$1/',
          '^apps/api/src/contexts/[^/]+/application/index\\.ts$',
        ],
      },
    },
    {
      name: 'web-features-are-isolated',
      comment: 'Frontend features never import other features internals.',
      severity: 'error',
      from: { path: '^apps/web/src/features/([^/]+)/' },
      to: {
        path: '^apps/web/src/features/([^/]+)/',
        pathNot: ['^apps/web/src/features/$1/'],
      },
    },
    {
      name: 'web-does-not-import-api',
      severity: 'error',
      from: { path: '^apps/web/' },
      to: { path: '^apps/api/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: {
      path: '(node_modules|dist|apps/hosting/public|apps/hosting-cloudflare/(public|\\.wrangler)|\\.turbo|test-results|playwright-report)',
    },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'types', 'default'],
      extensions: ['.ts', '.tsx', '.js'],
    },
  },
};
