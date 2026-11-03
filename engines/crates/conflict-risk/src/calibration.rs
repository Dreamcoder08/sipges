//! Score → probability (`calibration.ts`, docs/adr/0031 §3–4): Platt scaling
//! `p = σ(a + b·score)` fitted by damped Newton steps with a small ridge on `b` and `b ≥ 0`,
//! the Brier score and the reliability bins.

use serde_json::{Map, Value};
use sipges_analytics_common::js;

use crate::jsmath;

/// A back-test sample.
#[derive(Debug, Clone, Copy)]
pub struct Sample {
    /// Score at the cut-off.
    pub score: f64,
    /// Whether the unit escalated within the horizon.
    pub escalated: bool,
}

/// Fitted Platt parameters.
#[derive(Debug, Clone, Copy)]
pub struct Platt {
    /// Intercept.
    pub a: f64,
    /// Slope (≥ 0).
    pub b: f64,
}

fn sigma(x: f64) -> f64 {
    1.0 / (1.0 + jsmath::exp(-x))
}

const RIDGE: f64 = 1.0;

fn clamp(step: f64) -> f64 {
    jsmath::max(-5.0, jsmath::min(5.0, step))
}

#[allow(clippy::cast_precision_loss)] // sample counts are far below 2^53
fn base_rate(samples: &[Sample]) -> f64 {
    (samples.iter().filter(|s| s.escalated).count() as f64 + 0.5) / (samples.len() as f64 + 1.0)
}

fn logit(p: f64) -> f64 {
    jsmath::log(p / (1.0 - p))
}

/// `fitPlatt(samples)`.
#[must_use]
pub fn fit_platt(samples: &[Sample]) -> Platt {
    let intercept = Platt {
        a: logit(base_rate(samples)),
        b: 0.0,
    };
    let Platt { mut a, mut b } = intercept;
    for _ in 0..50 {
        let mut ga = 0.0;
        let mut gb = RIDGE * b;
        let mut haa = 1e-9;
        let mut hab = 0.0;
        let mut hbb = RIDGE;
        for &Sample { score, escalated } in samples {
            let p = sigma(a + b * score);
            let r = p - if escalated { 1.0 } else { 0.0 };
            let w = p * (1.0 - p);
            ga += r;
            gb += r * score;
            haa += w;
            hab += w * score;
            hbb += w * score * score;
        }
        let det = haa * hbb - hab * hab;
        if det.abs() < 1e-12 {
            break;
        }
        let da = clamp((hbb * ga - hab * gb) / det);
        let db = clamp((haa * gb - hab * ga) / det);
        a -= da;
        b -= db;
        if da.abs() + db.abs() < 1e-9 {
            break;
        }
    }
    if a.is_finite() && b.is_finite() && b >= 0.0 {
        Platt { a, b }
    } else {
        intercept
    }
}

/// `probability(platt, score)`.
#[must_use]
pub fn probability(platt: Platt, score: f64) -> f64 {
    sigma(platt.a + platt.b * score)
}

/// `roundProbability(p)`: to 5 points.
#[must_use]
pub fn round_probability(p: f64) -> f64 {
    jsmath::round(p * 20.0) / 20.0
}

/// `probabilityBand(p)`.
#[must_use]
pub fn probability_band(p: f64) -> &'static str {
    if p < 0.15 {
        "baja"
    } else if p < 0.4 {
        "media"
    } else {
        "alta"
    }
}

/// `signalBand(score)`: thresholds on the score when there is no calibration.
#[must_use]
pub fn signal_band(score: f64) -> &'static str {
    if score < 1.0 {
        "baja"
    } else if score < 2.5 {
        "media"
    } else {
        "alta"
    }
}

fn y(escalated: bool) -> f64 {
    if escalated { 1.0 } else { 0.0 }
}

/// `brier(pairs)`; `None` without pairs.
#[must_use]
#[allow(clippy::cast_precision_loss)] // pair counts are far below 2^53
pub fn brier(pairs: &[(f64, bool)]) -> Option<f64> {
    if pairs.is_empty() {
        return None;
    }
    // `(p − y) ** 2`: V8's pow returns `x * x` for an exponent of 2 (fdlibm `e_pow.c`).
    let total = pairs.iter().fold(0.0, |n, &(p, e)| {
        let d = p - y(e);
        n + d * d
    });
    Some(total / pairs.len() as f64)
}

const BIN_EDGES: [(f64, f64, &str); 3] = [
    (0.0, 0.15, "0–15 %"),
    (0.15, 0.4, "15–40 %"),
    (0.4, 1.01, "40–100 %"),
];

#[allow(clippy::cast_precision_loss)] // value counts are far below 2^53
fn mean(values: &[f64]) -> Value {
    if values.is_empty() {
        return Value::Null;
    }
    let total = values.iter().fold(0.0, |n, v| n + v);
    js::number(jsmath::round((total / values.len() as f64) * 1000.0) / 1000.0)
}

/// `reliabilityBins(pairs)`: mean predicted vs. observed rate in the three probability bands.
#[must_use]
pub fn reliability_bins(pairs: &[(f64, bool)]) -> Value {
    Value::Array(
        BIN_EDGES
            .iter()
            .map(|&(lo, hi, range)| {
                let in_bin: Vec<(f64, bool)> = pairs
                    .iter()
                    .copied()
                    .filter(|&(p, _)| p >= lo && p < hi)
                    .collect();
                let mut bin = Map::new();
                bin.insert("range".into(), Value::from(range));
                bin.insert("n".into(), Value::from(in_bin.len()));
                bin.insert(
                    "predicted".into(),
                    mean(&in_bin.iter().map(|&(p, _)| p).collect::<Vec<_>>()),
                );
                bin.insert(
                    "observed".into(),
                    mean(&in_bin.iter().map(|&(_, e)| y(e)).collect::<Vec<_>>()),
                );
                Value::Object(bin)
            })
            .collect(),
    )
}
