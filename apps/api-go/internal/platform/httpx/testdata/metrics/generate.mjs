// Records what the TypeScript metrics print for synthetic observations, without the process
// lines: node --experimental-strip-types generate.mjs > metrics.txt
import { createMetrics } from '../../../../../../api/src/platform/observability/metrics.ts';

const metrics = createMetrics(0);
metrics.observe('GET', '/api/:module', 200, 0.004);
metrics.observe('GET', '/api/:module', 200, 0.03);
metrics.observe('GET', '/api/:module', 404, 0.25);
metrics.observe('POST', '/api/:module', 500, 12);
metrics.observe('GET', '/health', 200, 0.001);
metrics.observe('HEAD', 'unmatched', 404, 1);
metrics.observe('GET', 'a"b\\c\nd', 301, 0.0000015);
const text = metrics.render(0);
process.stdout.write(text.slice(0, text.indexOf('# HELP sipges_process_uptime_seconds')));
