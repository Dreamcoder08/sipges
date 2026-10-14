export type GraphNode = { readonly id: string; readonly label: string; readonly group: string };
export type GraphEdge = {
  readonly source: string;
  readonly target: string;
  readonly label: string;
  readonly dashed?: boolean;
};
export type Point = { readonly x: number; readonly y: number };

/**
 * Deterministic force-directed layout (Fruchterman–Reingold with linear cooling). The same
 * graph always gets the same picture, which keeps tests and screenshots stable. `root` starts
 * at the centre and stays pinned there.
 */
export const layoutGraph = (
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  options: { width: number; height: number; root?: string; iterations?: number },
): Map<string, Point> => {
  const { width, height, root, iterations = 300 } = options;
  const n = nodes.length;
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const pinned = nodes.map((node) => node.id === root);
  let placed = 0;
  const others = nodes.filter((node) => node.id !== root).length;
  nodes.forEach((node, i) => {
    if (pinned[i]) {
      xs[i] = width / 2;
      ys[i] = height / 2;
      return;
    }
    const angle = (2 * Math.PI * placed) / Math.max(1, others);
    const radius = Math.min(width, height) * (0.25 + 0.15 * (placed % 2));
    xs[i] = width / 2 + radius * Math.cos(angle);
    ys[i] = height / 2 + radius * Math.sin(angle);
    placed++;
  });

  if (n >= 2) {
    const k = Math.sqrt((width * height) / n) * 0.75;
    const pairs = edges.flatMap((edge) => {
      const a = index.get(edge.source);
      const b = index.get(edge.target);
      return a === undefined || b === undefined || a === b ? [] : [[a, b] as const];
    });
    const dx = new Float64Array(n);
    const dy = new Float64Array(n);
    const margin = 30;
    let temperature = Math.min(width, height) / 8;
    const cooling = temperature / (iterations + 1);
    for (let step = 0; step < iterations; step++) {
      dx.fill(0);
      dy.fill(0);
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          let ux = (xs[i] ?? 0) - (xs[j] ?? 0);
          let uy = (ys[i] ?? 0) - (ys[j] ?? 0);
          if (ux === 0 && uy === 0) {
            ux = 0.01 * (i + 1);
            uy = 0.01 * (j + 1);
          }
          const distance = Math.hypot(ux, uy);
          const force = (k * k) / distance / distance;
          dx[i] = (dx[i] ?? 0) + ux * force;
          dy[i] = (dy[i] ?? 0) + uy * force;
          dx[j] = (dx[j] ?? 0) - ux * force;
          dy[j] = (dy[j] ?? 0) - uy * force;
        }
      }
      for (const [a, b] of pairs) {
        const ux = (xs[a] ?? 0) - (xs[b] ?? 0);
        const uy = (ys[a] ?? 0) - (ys[b] ?? 0);
        const distance = Math.max(0.01, Math.hypot(ux, uy));
        const force = distance / k;
        dx[a] = (dx[a] ?? 0) - ux * force;
        dy[a] = (dy[a] ?? 0) - uy * force;
        dx[b] = (dx[b] ?? 0) + ux * force;
        dy[b] = (dy[b] ?? 0) + uy * force;
      }
      for (let i = 0; i < n; i++) {
        if (pinned[i]) continue;
        const sx = dx[i] ?? 0;
        const sy = dy[i] ?? 0;
        const length = Math.max(0.01, Math.hypot(sx, sy));
        const move = Math.min(length, temperature);
        xs[i] = Math.min(width - margin, Math.max(margin, (xs[i] ?? 0) + (sx / length) * move));
        ys[i] = Math.min(height - margin, Math.max(margin, (ys[i] ?? 0) + (sy / length) * move));
      }
      temperature -= cooling;
    }
  }
  return new Map(nodes.map((node, i) => [node.id, { x: xs[i] ?? 0, y: ys[i] ?? 0 }]));
};
