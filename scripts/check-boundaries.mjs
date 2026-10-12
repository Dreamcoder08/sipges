// Enforces the hexagonal dependency rules (docs/adr/0002) and refuses to pass vacuously:
// 1. a fixture with a known violation must be reported, proving the rules are active;
// 2. the real workspace must cruise at least one module and report no violations.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { cruise } from 'dependency-cruiser';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = require(path.join(root, '.dependency-cruiser.cjs'));

const run = async (baseDir, scan) => {
  // dependency-cruiser resolves the scan list against the working directory, not baseDir.
  process.chdir(baseDir);
  const { output } = await cruise(scan, {
    ...config.options,
    ruleSet: { forbidden: config.forbidden },
    baseDir,
    validate: true,
  });
  return output.summary;
};

const fixture = await run(path.join(root, 'scripts', 'boundary-fixture'), ['apps']);
if (fixture.totalCruised === 0) {
  console.error('Boundary self-test cruised 0 fixture modules.');
  process.exit(1);
}
const fixtureRules = new Set(fixture.violations.map((v) => v.rule.name));
if (!fixtureRules.has('domain-is-pure')) {
  console.error('Boundary self-test failed: fixture violation "domain-is-pure" was not detected.');
  process.exit(1);
}

const real = await run(root, ['apps', 'packages']);
if (real.totalCruised === 0) {
  console.error('Boundary check cruised 0 modules; refusing to pass vacuously.');
  process.exit(1);
}
for (const v of real.violations) {
  console.error(`${v.rule.severity} ${v.rule.name}: ${v.from} -> ${v.to}`);
}
if (real.error > 0) process.exit(1);
console.log(
  `Boundaries OK: ${real.totalCruised} modules, ${real.totalDependenciesCruised} dependencies.`,
);
