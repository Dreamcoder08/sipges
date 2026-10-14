/** Upper bounds in seconds for request duration buckets. */
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

type Series = { count: number; sum: number; buckets: number[] };

const escapeLabel = (value: string) =>
  value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');

/**
 * In-process HTTP metrics in the Prometheus text exposition format. Labels use the matched
 * route pattern (never the raw path), so ids and queries cannot blow up cardinality.
 */
export const createMetrics = (startedAt = Date.now()) => {
  const requests = new Map<string, number>();
  const durations = new Map<string, Series>();

  return {
    observe(method: string, route: string, status: number, seconds: number) {
      const statusClass = `${Math.floor(status / 100)}xx`;
      const requestKey = `${method}\u0000${route}\u0000${statusClass}`;
      requests.set(requestKey, (requests.get(requestKey) ?? 0) + 1);
      const durationKey = `${method}\u0000${route}`;
      const series = durations.get(durationKey) ?? {
        count: 0,
        sum: 0,
        buckets: BUCKETS.map(() => 0),
      };
      series.count += 1;
      series.sum += seconds;
      BUCKETS.forEach((bound, index) => {
        if (seconds <= bound) series.buckets[index] = (series.buckets[index] ?? 0) + 1;
      });
      durations.set(durationKey, series);
    },

    render(now = Date.now()): string {
      const lines = [
        '# HELP mascli_http_requests_total HTTP requests by method, route and status class.',
        '# TYPE mascli_http_requests_total counter',
      ];
      for (const [key, value] of [...requests].sort()) {
        const [method = '', route = '', status = ''] = key.split('\u0000');
        lines.push(
          `mascli_http_requests_total{method="${escapeLabel(method)}",route="${escapeLabel(route)}",status="${status}"} ${value}`,
        );
      }
      lines.push(
        '# HELP mascli_http_request_duration_seconds HTTP request duration.',
        '# TYPE mascli_http_request_duration_seconds histogram',
      );
      for (const [key, series] of [...durations].sort(([a], [b]) => a.localeCompare(b))) {
        const [method = '', route = ''] = key.split('\u0000');
        const labels = `method="${escapeLabel(method)}",route="${escapeLabel(route)}"`;
        BUCKETS.forEach((bound, index) =>
          lines.push(
            `mascli_http_request_duration_seconds_bucket{${labels},le="${bound}"} ${series.buckets[index] ?? 0}`,
          ),
        );
        lines.push(
          `mascli_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${series.count}`,
          `mascli_http_request_duration_seconds_sum{${labels}} ${series.sum.toFixed(6)}`,
          `mascli_http_request_duration_seconds_count{${labels}} ${series.count}`,
        );
      }
      const memory = process.memoryUsage();
      lines.push(
        '# HELP mascli_process_uptime_seconds Seconds since the API started.',
        '# TYPE mascli_process_uptime_seconds gauge',
        `mascli_process_uptime_seconds ${((now - startedAt) / 1000).toFixed(3)}`,
        '# HELP mascli_process_resident_memory_bytes Resident set size.',
        '# TYPE mascli_process_resident_memory_bytes gauge',
        `mascli_process_resident_memory_bytes ${memory.rss}`,
        '# HELP mascli_process_heap_used_bytes V8 heap in use.',
        '# TYPE mascli_process_heap_used_bytes gauge',
        `mascli_process_heap_used_bytes ${memory.heapUsed}`,
      );
      return `${lines.join('\n')}\n`;
    },
  };
};

export type Metrics = ReturnType<typeof createMetrics>;
