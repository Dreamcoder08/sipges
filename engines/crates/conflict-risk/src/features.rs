//! Factors of one unit as of a day (`features.ts`, docs/adr/0031 §2). Only signals dated on or
//! before the day are read and statuses count as of that day, so the same call serves the
//! back-test without leakage: `assertNoLeakage` can never fire on these factors.

use sipges_analytics_common::EngineError;

use crate::dates::{add_days, day_of, days_between};
use crate::jsmath;
use crate::signals::{IrsaPoint, Kind, Signal, SignalIndex};

/// `FACTORS[id]`: id, weight and the words the screen shows.
#[derive(Debug, Clone, Copy)]
pub struct FactorSpec {
    /// Factor id.
    pub id: &'static str,
    /// Fixed weight.
    pub weight: f64,
    /// Label.
    pub label: &'static str,
}

const fn spec(id: &'static str, weight: f64, label: &'static str) -> FactorSpec {
    FactorSpec { id, weight, label }
}

const OPEN_DEMANDS: FactorSpec = spec("open_demands", 0.6, "Demandas abiertas (últimos 180 días)");
const OVERDUE_COMMITMENTS: FactorSpec = spec(
    "overdue_commitments",
    0.8,
    "Compromisos vencidos sin cumplir",
);
const NEGATIVE_NARRATIVES: FactorSpec = spec(
    "negative_narratives",
    0.5,
    "Narrativas críticas (últimos 90 días)",
);
const NARRATIVE_RISE: FactorSpec = spec(
    "narrative_rise",
    0.4,
    "Aumento de narrativas críticas (último mes)",
);
const ALERTS: FactorSpec = spec("alerts", 0.9, "Alertas (últimos 90 días, por nivel)");
const ESCALATIONS: FactorSpec = spec(
    "escalations",
    0.7,
    "Escalamientos recientes (últimos 90 días)",
);
const IRSA: FactorSpec = spec("irsa", 0.8, "IRSA del proyecto");
const IRSA_RISE: FactorSpec = spec("irsa_rise", 0.4, "Subida del IRSA (últimos 90 días)");
const RECENCY: FactorSpec = spec("recency", 0.5, "Días desde la última señal");

/// `Factor`.
#[derive(Debug, Clone)]
pub struct Factor {
    /// Which factor.
    pub spec: FactorSpec,
    /// What was counted, rounded to 3 decimals.
    pub count: f64,
    /// The transformed value, rounded to 3 decimals.
    pub value: f64,
    /// `weight × value`, rounded to 3 decimals.
    pub contribution: f64,
    /// Newest first, at most five; indices into `SignalIndex::signals`.
    pub records: Vec<usize>,
}

const MAX_REFS: usize = 5;

/// `round(value, 3)`.
#[must_use]
pub fn round3(value: f64) -> f64 {
    jsmath::round(value * 1000.0) / 1000.0
}

fn day(s: &str, days: i64) -> Result<String, EngineError> {
    add_days(s, days).ok_or_else(|| EngineError::UnsupportedValue(format!("{s} is not a day")))
}

/// Window `(since, t]`.
fn after(s: &Signal, since: &str, t: &str) -> bool {
    s.date.as_str() > since && s.date.as_str() <= t
}

fn open_at(s: &Signal, t: &str) -> bool {
    s.closed_on.as_deref().is_none_or(|closed| closed > t)
}

fn sum(signals: &[(usize, &Signal)]) -> f64 {
    signals.iter().fold(0.0, |n, (_, s)| n + s.weight)
}

/// Latest IRSA value on or before `day` (the last of its day), with that day.
fn irsa_at(points: &[IrsaPoint<'_>], day: &str) -> Option<(String, f64)> {
    let mut best: Option<(String, f64)> = None;
    for p in points {
        if let Some(d) = day_of(p.ts)
            && d.as_str() <= day
            && best.as_ref().is_none_or(|(b, _)| d >= *b)
        {
            best = Some((d, p.irsa));
        }
    }
    best
}

/// `featuresAt(index, unit, t, irsa)`, sorted by contribution, highest first.
///
/// # Errors
/// `UnsupportedValue` when `t` is not a day (the TypeScript `toISOString` would throw).
#[allow(clippy::too_many_lines)] // one block per factor, in the order of `featuresAt`
pub fn features_at(
    index: &SignalIndex,
    unit: usize,
    t: &str,
    irsa: &[IrsaPoint<'_>],
) -> Result<Vec<Factor>, EngineError> {
    let ids = index
        .by_unit
        .get(unit)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let past: Vec<(usize, &Signal)> = ids
        .iter()
        .filter_map(|&i| index.signals.get(i).map(|s| (i, s)))
        .filter(|(_, s)| s.date.as_str() <= t)
        .collect();
    let d30 = day(t, -30)?;
    let d90 = day(t, -90)?;
    let d180 = day(t, -180)?;
    let of = |kind: Kind| -> Vec<(usize, &Signal)> {
        past.iter()
            .copied()
            .filter(|(_, s)| s.kind == kind)
            .collect()
    };
    let mut factors: Vec<Factor> = Vec::new();
    let mut push = |spec: FactorSpec, count: f64, value: f64, basis: &[(usize, &Signal)]| {
        if value > 0.0 {
            factors.push(Factor {
                spec,
                count: round3(count),
                value: round3(value),
                contribution: round3(spec.weight * value),
                records: basis.iter().rev().take(MAX_REFS).map(|&(i, _)| i).collect(),
            });
        }
    };

    let demands: Vec<_> = of(Kind::Demand)
        .into_iter()
        .filter(|(_, s)| after(s, &d180, t) && open_at(s, t))
        .collect();
    push(
        OPEN_DEMANDS,
        sum(&demands),
        jsmath::log1p(sum(&demands)),
        &demands,
    );

    let overdue: Vec<_> = of(Kind::Commitment)
        .into_iter()
        .filter(|(_, s)| s.due_date.as_deref().is_some_and(|due| due < t) && open_at(s, t))
        .collect();
    let n = count(&overdue);
    push(OVERDUE_COMMITMENTS, n, jsmath::log1p(n), &overdue);

    let last90: Vec<_> = of(Kind::Narrative)
        .into_iter()
        .filter(|(_, s)| s.negative && after(s, &d90, t))
        .collect();
    let n90 = count(&last90);
    push(NEGATIVE_NARRATIVES, n90, jsmath::log1p(n90), &last90);
    let last30: Vec<_> = last90
        .iter()
        .copied()
        .filter(|(_, s)| after(s, &d30, t))
        .collect();
    let n30 = count(&last30);
    let rise = jsmath::min(3.0, jsmath::max(0.0, n30 - (n90 - n30) / 2.0));
    push(NARRATIVE_RISE, rise, jsmath::log1p(rise), &last30);

    let alerts: Vec<_> = of(Kind::Alert)
        .into_iter()
        .filter(|(_, s)| after(s, &d90, t) && open_at(s, t))
        .collect();
    push(ALERTS, sum(&alerts), jsmath::log1p(sum(&alerts)), &alerts);

    let escalations: Vec<_> = of(Kind::Escalation)
        .into_iter()
        .filter(|(_, s)| after(s, &d90, t))
        .collect();
    let n = count(&escalations);
    push(ESCALATIONS, n, jsmath::log1p(n), &escalations);

    if let Some((_, level)) = irsa_at(irsa, t) {
        push(IRSA, level, level / 100.0, &[]);
        // `before ?? the earliest point in (d90, t]` (the first of the earliest day).
        let start = irsa_at(irsa, &d90).map(|(_, v)| v).or_else(|| {
            let mut first: Option<(String, f64)> = None;
            for p in irsa {
                if let Some(d) = day_of(p.ts)
                    && d > d90
                    && d.as_str() <= t
                    && first.as_ref().is_none_or(|(b, _)| d < *b)
                {
                    first = Some((d, p.irsa));
                }
            }
            first.map(|(_, v)| v)
        });
        if let Some(start) = start {
            let delta = level - start;
            push(
                IRSA_RISE,
                delta,
                jsmath::min(1.0, jsmath::max(0.0, delta / 25.0)),
                &[],
            );
        }
    }

    if let Some(&(i, last)) = past.last() {
        let days = days_between(&last.date, t)
            .ok_or_else(|| EngineError::UnsupportedValue(format!("{t} is not a day")))?;
        #[allow(clippy::cast_precision_loss)] // day counts are far below 2^53
        let days = days as f64;
        push(RECENCY, days, jsmath::exp(-days / 30.0), &[(i, last)]);
    }
    // Stable, like Array.prototype.sort; a NaN difference counts as equal.
    factors.sort_by(|a, b| descending(a.contribution, b.contribution));
    Ok(factors)
}

#[allow(clippy::cast_precision_loss)] // list lengths are far below 2^53
fn count(list: &[(usize, &Signal)]) -> f64 {
    list.len() as f64
}

/// The order of a JavaScript comparator `(a, b) => b − a`: `NaN` and zero are equal.
#[must_use]
pub fn descending(a: f64, b: f64) -> std::cmp::Ordering {
    let d = b - a;
    if d > 0.0 {
        std::cmp::Ordering::Greater
    } else if d < 0.0 {
        std::cmp::Ordering::Less
    } else {
        std::cmp::Ordering::Equal
    }
}

/// `scoreOf(factors)`.
#[must_use]
pub fn score_of(factors: &[Factor]) -> f64 {
    round3(factors.iter().fold(0.0, |n, f| n + f.contribution))
}

/// `recentSignals(index, unit, t)`: signals of the unit in `(t − 180, t]`.
///
/// # Errors
/// As [`features_at`].
pub fn recent_signals(index: &SignalIndex, unit: usize, t: &str) -> Result<usize, EngineError> {
    let since = day(t, -180)?;
    Ok(index.of(unit).filter(|s| after(s, &since, t)).count())
}

/// `escalatedWithin(index, unit, t, horizon)`: an escalation in `(t, t + horizon]`.
///
/// # Errors
/// As [`features_at`].
pub fn escalated_within(
    index: &SignalIndex,
    unit: usize,
    t: &str,
    horizon: i64,
) -> Result<bool, EngineError> {
    let until = day(t, horizon)?;
    Ok(index.of(unit).any(|s| {
        s.kind == Kind::Escalation && s.date.as_str() > t && s.date.as_str() <= until.as_str()
    }))
}
