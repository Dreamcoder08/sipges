import { appendFile } from 'node:fs/promises';
import type { CDPSession, Page } from '@playwright/test';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';
import { watchNetwork } from '../support/network.ts';

/**
 * Render cost of the heavy screens (React Compiler trial, docs/benchmarks/react-compiler-trial.md).
 *
 * Not a budget: it only runs when SIPGES_REACT_TRIAL_OUT names a JSON-lines file, so the default
 * CI run skips it. For each screen it replays a fixed script of interactions with the CPU slowed
 * 4× and records, from the first to the last interaction:
 * - event timing: the longest event duration of each interaction (the INP measure), from a
 *   PerformanceObserver of type `event`;
 * - main-thread busy time running script and tasks (CDP Performance metrics ScriptDuration and
 *   TaskDuration), which leaves out the idle gaps between interactions that event durations
 *   include, so load elsewhere on the machine moves it less;
 * - React commits and the function/class components that rendered in them, counted through the
 *   DevTools hook production React DOM calls on every commit. A component counts when it ran in
 *   that commit; subtrees React skipped are not walked.
 * SIPGES_REACT_TRIAL_LABEL names the build in each line (for example `baseline` or `compiler`).
 */
const OUT = process.env.SIPGES_REACT_TRIAL_OUT;
const LABEL = process.env.SIPGES_REACT_TRIAL_LABEL ?? 'unlabelled';
const CPU_SLOWDOWN = 4;

type Sample = {
  commits: number;
  rendered: number;
  top: [string, number][];
  interactions: number[];
  /** Main-thread busy time in ms (CDP Performance metrics), under the CPU slowdown. */
  scriptMs: number;
  taskMs: number;
};

/** ScriptDuration and TaskDuration, in seconds since Performance.enable. */
const cpuMetrics = async (cdp: CDPSession) => {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const by = new Map(metrics.map((m) => [m.name, m.value]));
  return { script: by.get('ScriptDuration') ?? 0, task: by.get('TaskDuration') ?? 0 };
};

declare global {
  interface Window {
    __renderCost?: {
      commits: number;
      rendered: number;
      byName: Map<string, number>;
      durations: Map<number, number>;
    };
  }
}

/** Runs before any page script: a minimal DevTools hook and an event-timing observer. */
const instrument = () => {
  const cost = {
    commits: 0,
    rendered: 0,
    byName: new Map<string, number>(),
    durations: new Map<number, number>(),
  };
  window.__renderCost = cost;
  // FunctionComponent 0, ClassComponent 1, ForwardRef 11, SimpleMemoComponent 15.
  const composite = new Set([0, 1, 11, 15]);
  const PERFORMED_WORK = 1;
  type Fiber = {
    tag: number;
    flags: number;
    type: { name?: string; displayName?: string; render?: { name?: string } } | null;
    child: Fiber | null;
    sibling: Fiber | null;
    alternate: Fiber | null;
  };
  const countRendered = (root: Fiber) => {
    let rendered = 0;
    const stack: Fiber[] = [root];
    while (stack.length) {
      const fiber = stack.pop() as Fiber;
      const previous = fiber.alternate;
      if (composite.has(fiber.tag) && (!previous || fiber.flags & PERFORMED_WORK)) {
        rendered += 1;
        const type = fiber.type;
        const name = type?.displayName || type?.name || type?.render?.name || 'anonymous';
        cost.byName.set(name, (cost.byName.get(name) ?? 0) + 1);
      }
      // A skipped subtree keeps the previous commit's child list: nothing in it ran.
      if (fiber.child && (!previous || fiber.child !== previous.child)) {
        for (let child: Fiber | null = fiber.child; child; child = child.sibling) stack.push(child);
      }
    }
    return rendered;
  };
  (window as unknown as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject() {
      return 1;
    },
    checkDCE() {},
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id: number, root: { current: Fiber }) {
      cost.commits += 1;
      cost.rendered += countRendered(root.current);
    },
  };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as PerformanceEventTiming[]) {
      if (!entry.interactionId) continue;
      const known = cost.durations.get(entry.interactionId) ?? 0;
      cost.durations.set(entry.interactionId, Math.max(known, entry.duration));
    }
  }).observe({ type: 'event', buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
};

const reset = (page: Page) =>
  page.evaluate(() => {
    const cost = window.__renderCost;
    if (!cost) throw new Error('render-cost instrumentation is missing');
    cost.commits = 0;
    cost.rendered = 0;
    cost.byName.clear();
    cost.durations.clear();
  });

const read = async (page: Page): Promise<Omit<Sample, 'scriptMs' | 'taskMs'>> => {
  // Event timing entries are delivered after the next paint.
  await page.waitForTimeout(500);
  return page.evaluate(() => {
    const cost = window.__renderCost;
    if (!cost) throw new Error('render-cost instrumentation is missing');
    return {
      commits: cost.commits,
      rendered: cost.rendered,
      // Names survive only in an unminified build; they find what to annotate.
      top: [...cost.byName].sort((a, b) => b[1] - a[1]).slice(0, 15),
      interactions: [...cost.durations.values()].sort((a, b) => a - b),
    };
  });
};

/** Measures `script` on an already loaded screen, CPU slowed. */
const measure = async (
  page: Page,
  cdp: CDPSession,
  settled: () => Promise<void>,
  script: () => Promise<void>,
) => {
  await settled();
  await reset(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN });
  try {
    const before = await cpuMetrics(cdp);
    await script();
    const sample = await read(page);
    const after = await cpuMetrics(cdp);
    return {
      ...sample,
      scriptMs: Math.round((after.script - before.script) * 1000),
      taskMs: Math.round((after.task - before.task) * 1000),
    };
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  }
};

const PLACES = ['Vice, Sechura', 'Bayóvar', 'Sechura', 'Parachique', 'Bellavista de la Unión'];

test('render cost of Inicio, Registros, IRSA and Territorio', async ({
  page,
  admin,
  adminApi,
  browserName,
}) => {
  test.skip(!OUT, 'SIPGES_REACT_TRIAL_OUT is not set');
  test.skip(browserName !== 'chromium', 'CPU throttling needs the Chromium DevTools protocol');
  test.setTimeout(300_000);
  const stamp = Date.now();
  for (let n = 0; n < 40; n += 1) {
    const created = await adminApi.post('/api/eventos', {
      headers: { 'X-SIPGES-Scope': DEFAULT_SCOPE },
      data: {
        payload: {
          Descripcion_Hecho: `Hecho sintético de medición ${n} ${stamp}`,
          Fecha: `2026-10-${String((n % 28) + 1).padStart(2, '0')}`,
          Territorio: PLACES[n % PLACES.length],
        },
      },
    });
    expect(created.status(), await created.text()).toBe(200);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // Territorio's SVG renderer keeps the markers in the DOM and the GPU out of the numbers.
  await page.addInitScript(() => {
    delete (window as { WebGL2RenderingContext?: unknown }).WebGL2RenderingContext;
  });
  await page.addInitScript(instrument);
  await signInToProject(page, admin, DEFAULT_SCOPE);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const settled = watchNetwork(page);
  const results: Record<string, Sample> = {};

  await page.goto('/inicio');
  const composer = page.getByRole('textbox', { name: /^Buscar en registros de / });
  await expect(composer).toBeEnabled();
  results.inicio = await measure(page, cdp, settled, async () => {
    await composer.click();
    await page.keyboard.type('acta pendiente agua', { delay: 60 });
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
  });

  await page.goto('/registros?tipo=todos');
  const grid = page.getByRole('grid', { name: 'Registros de todos los tipos del proyecto activo' });
  await expect(grid.getByRole('row').filter({ hasText: `medición 0 ${stamp}` })).toBeVisible();
  const density = page.getByRole('group', { name: 'Densidad de filas' });
  results.registros = await measure(page, cdp, settled, async () => {
    for (const name of ['Cómoda', 'Compacta', 'Cómoda', 'Compacta'])
      await density.getByRole('button', { name }).click();
    await grid
      .getByRole('row')
      .filter({ hasText: `medición 0 ${stamp}` })
      .getByRole('gridcell')
      .last()
      .click();
    await expect(page.getByRole('dialog', { name: /^Ficha / })).toBeVisible();
    for (let n = 0; n < 5; n += 1) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
  });

  await page.goto('/irsa');
  await expect(page.getByRole('heading', { level: 1, name: 'IRSA-SIPGES' })).toBeVisible();
  results.irsa = await measure(page, cdp, settled, async () => {
    await page.getByText('Cómo se calcula').click();
    await page.getByText('Cómo se calcula').click();
    await page.getByLabel('Nota del corte').click();
    await page.keyboard.type('corte sintético medición', { delay: 60 });
  });

  await page.goto('/territorio');
  const list = page.getByRole('list', { name: 'Registros en el mapa' });
  const rows = list.getByRole('button', { name: new RegExp(`medición \\d+ ${stamp}`) });
  await expect(rows.first()).toBeVisible();
  results.territorio = await measure(page, cdp, settled, async () => {
    for (let n = 0; n < 6; n += 1) {
      await rows.nth(n).click();
      await expect(rows.nth(n)).toHaveAttribute('aria-pressed', 'true');
    }
  });

  if (OUT) await appendFile(OUT, `${JSON.stringify({ label: LABEL, at: stamp, results })}\n`);
  for (const [screen, sample] of Object.entries(results))
    console.log(
      `${LABEL} ${screen}: ${sample.commits} commits, ${sample.rendered} components rendered, script ${sample.scriptMs} ms, task ${sample.taskMs} ms, interactions ${sample.interactions.join('/')} ms`,
    );
});
