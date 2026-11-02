/**
 * Score → probability (docs/adr/0031 §3–4): Platt scaling `p = σ(a + b·score)` fitted by Newton
 * steps with a small ridge on `b` and `b ≥ 0`, plus the bands the screen shows.
 */

export type Sample = { readonly score: number; readonly escalated: boolean };
export type Platt = { readonly a: number; readonly b: number };
export type Band = 'alta' | 'media' | 'baja';
export type Confidence = 'alta' | 'media' | 'baja';

const sigma = (x: number) => 1 / (1 + Math.exp(-x));
const RIDGE = 1;
const clamp = (step: number) => Math.max(-5, Math.min(5, step));

const baseRate = (samples: readonly Sample[]) =>
  (samples.filter((s) => s.escalated).length + 0.5) / (samples.length + 1);

const logit = (p: number) => Math.log(p / (1 - p));

export const fitPlatt = (samples: readonly Sample[]): Platt => {
  const intercept = { a: logit(baseRate(samples)), b: 0 };
  let { a, b } = intercept;
  for (let step = 0; step < 50; step += 1) {
    let ga = 0;
    let gb = RIDGE * b;
    let haa = 1e-9;
    let hab = 0;
    let hbb = RIDGE;
    for (const { score, escalated } of samples) {
      const p = sigma(a + b * score);
      const r = p - (escalated ? 1 : 0);
      const w = p * (1 - p);
      ga += r;
      gb += r * score;
      haa += w;
      hab += w * score;
      hbb += w * score * score;
    }
    const det = haa * hbb - hab * hab;
    if (Math.abs(det) < 1e-12) break;
    // Damped Newton step: near-separable histories would otherwise overshoot.
    const da = clamp((hbb * ga - hab * gb) / det);
    const db = clamp((haa * gb - hab * ga) / det);
    a -= da;
    b -= db;
    if (Math.abs(da) + Math.abs(db) < 1e-9) break;
  }
  // More signals never lower the risk: a negative slope falls back to the base rate.
  return Number.isFinite(a) && Number.isFinite(b) && b >= 0 ? { a, b } : intercept;
};

export const probability = (platt: Platt, score: number) => sigma(platt.a + platt.b * score);

/** Rounded to 5 points: the history does not support more precision. */
export const roundProbability = (p: number) => Math.round(p * 20) / 20;

export const probabilityBand = (p: number): Band =>
  p < 0.15 ? 'baja' : p < 0.4 ? 'media' : 'alta';

/** Without calibration only the signals speak: thresholds on the score, no percentage. */
export const signalBand = (score: number): Band =>
  score < 1 ? 'baja' : score < 2.5 ? 'media' : 'alta';

export const brier = (pairs: readonly { p: number; y: boolean }[]) =>
  pairs.length ? pairs.reduce((n, { p, y }) => n + (p - (y ? 1 : 0)) ** 2, 0) / pairs.length : null;

const BIN_EDGES = [
  [0, 0.15, '0–15 %'],
  [0.15, 0.4, '15–40 %'],
  [0.4, 1.01, '40–100 %'],
] as const;

/** Mean predicted vs. observed escalation rate in the three probability bands. */
export const reliabilityBins = (pairs: readonly { p: number; y: boolean }[]) =>
  BIN_EDGES.map(([lo, hi, range]) => {
    const inBin = pairs.filter(({ p }) => p >= lo && p < hi);
    const mean = (values: number[]) =>
      values.length
        ? Math.round((values.reduce((n, v) => n + v, 0) / values.length) * 1000) / 1000
        : null;
    return {
      range,
      n: inBin.length,
      predicted: mean(inBin.map(({ p }) => p)),
      observed: mean(inBin.map(({ y }) => (y ? 1 : 0))),
    };
  });
