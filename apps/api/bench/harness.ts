import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

export type Measurement = {
  readonly scenario: string;
  readonly scale: string;
  readonly runs: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  /** Longest event-loop stall seen while the scenario ran, in ms. */
  readonly loopBlock: number;
};

const percentile = (sorted: readonly number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;

const round = (ms: number) => Math.round(ms * 100) / 100;

/**
 * Runs `fn` after a warm-up and reports latency percentiles. Synchronous engines block the
 * event loop for their whole duration, so `loopBlock` is measured with a 1 ms histogram
 * resolution and, for sync code, is at least the longest single run.
 */
export const measure = async (
  scenario: string,
  scale: string,
  fn: () => unknown,
  options: { runs?: number; warmup?: number } = {},
): Promise<Measurement> => {
  const runs = options.runs ?? 30;
  for (let i = 0; i < (options.warmup ?? 3); i += 1) await fn();
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  const samples: number[] = [];
  let longestSync = 0;
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    const result = fn();
    const syncEnd = performance.now();
    if (result instanceof Promise) await result;
    const end = performance.now();
    samples.push(end - start);
    if (!(result instanceof Promise)) longestSync = Math.max(longestSync, syncEnd - start);
    // Let the histogram observe the loop between runs.
    await new Promise((resolve) => setImmediate(resolve));
  }
  histogram.disable();
  samples.sort((a, b) => a - b);
  const stall = Math.max(0, histogram.max / 1e6 - 1);
  return {
    scenario,
    scale,
    runs,
    p50: round(percentile(samples, 50)),
    p95: round(percentile(samples, 95)),
    max: round(samples.at(-1) ?? 0),
    loopBlock: round(Math.max(longestSync, stall)),
  };
};

/** ADR 0005 native-adapter gate. */
export const GATE = { p95: 500, loopBlock: 50 } as const;

export const tripsGate = (m: Measurement) => m.p95 > GATE.p95 || m.loopBlock > GATE.loopBlock;

export const table = (rows: readonly Measurement[]) =>
  [
    '| Scenario | Volume | Runs | p50 ms | p95 ms | max ms | Loop block ms | Gate |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |',
    ...rows.map(
      (m) =>
        `| ${m.scenario} | ${m.scale} | ${m.runs} | ${m.p50} | ${m.p95} | ${m.max} | ${m.loopBlock} | ${tripsGate(m) ? '**over**' : 'ok'} |`,
    ),
  ].join('\n');
