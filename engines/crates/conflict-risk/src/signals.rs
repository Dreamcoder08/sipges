//! Records, territorial alerts and IRSA snapshots as dated signals per unit (`signals.ts`,
//! docs/adr/0031 §1–2). Units come only from the record's own territory and actor fields.

use std::collections::HashMap;

use serde_json::{Map, Value};
use sipges_analytics_common::{EngineError, js};

use crate::dates::{day_of, record_due_date};
use crate::text::{fold, fold_value, is_terminal_status, to_js_string, utf16_len, utf16_prefix};

/// A record of the tenant (`RiskRecord`).
#[derive(Debug, Clone, Copy)]
pub struct RiskRecord<'a> {
    /// Module name, for example `Demandas`.
    pub module: &'a str,
    /// Record id.
    pub id: &'a str,
    /// Stored payload.
    pub payload: &'a Map<String, Value>,
    /// ISO timestamp of the last update; `None` when unknown.
    pub updated_at: Option<&'a str>,
}

/// A territorial alert (`RiskAlert`).
#[derive(Debug, Clone, Copy)]
pub struct RiskAlert<'a> {
    /// Alert id.
    pub id: &'a str,
    /// ISO timestamp.
    pub created_at: &'a str,
    /// Territory, when known.
    pub territory: Option<&'a str>,
    /// Alta, Media or Baja.
    pub level: &'a str,
    /// Review status.
    pub status: &'a str,
    /// ISO timestamp of the review, when reviewed.
    pub reviewed_at: Option<&'a str>,
}

/// A project IRSA snapshot (`IrsaPoint`).
#[derive(Debug, Clone, Copy)]
pub struct IrsaPoint<'a> {
    /// ISO timestamp.
    pub ts: &'a str,
    /// IRSA value.
    pub irsa: f64,
}

/// `RiskInput`.
#[derive(Debug, Clone)]
pub struct RiskInput<'a> {
    /// Records of every module.
    pub records: Vec<RiskRecord<'a>>,
    /// Territorial alerts.
    pub alerts: Vec<RiskAlert<'a>>,
    /// IRSA snapshots.
    pub irsa: Vec<IrsaPoint<'a>>,
    /// The prediction day, `YYYY-MM-DD`.
    pub today: &'a str,
}

/// `SignalKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// `demand`.
    Demand,
    /// `commitment`.
    Commitment,
    /// `narrative`.
    Narrative,
    /// `alert`.
    Alert,
    /// `escalation`.
    Escalation,
    /// `event`.
    Event,
}

/// A record title as `shortTitle` leaves it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Title {
    /// The text, without the lone surrogate when [`Title::split`].
    pub text: String,
    /// The 117-unit cut split a surrogate pair: TypeScript keeps a lone high surrogate there.
    pub split: bool,
}

/// `Signal`: a dated source reference with its units and weight.
#[derive(Debug, Clone)]
pub struct Signal {
    /// Source module.
    pub module: String,
    /// Source id.
    pub id: String,
    /// Short title.
    pub title: Title,
    /// `YYYY-MM-DD`.
    pub date: String,
    /// Kind.
    pub kind: Kind,
    /// Unit keys: `L:<folded locality>` and `A:<folded actor>`.
    pub units: Vec<String>,
    /// Weight; `NaN` where TypeScript's would not be a number (see [`alert_weight`]).
    pub weight: f64,
    /// Day the record became closed or discarded; `None` while open.
    pub closed_on: Option<String>,
    /// Commitments only.
    pub due_date: Option<String>,
    /// Narratives only: critical or negative tone.
    pub negative: bool,
}

/// `TERRITORIAL_ALERT_MODULE`.
pub const TERRITORIAL_ALERT_MODULE: &str = "Alertas_Territoriales";
const GENERATED_ORIGIN: &str = "SIPGES";
const TERRITORY_FIELDS: [&str; 4] = ["Territorio", "Comunidad", "Localidad", "Distrito"];

/// `SPECS[module]`: (dates, titles, actors).
type Spec = (
    &'static [&'static str],
    &'static [&'static str],
    &'static [&'static str],
);

fn spec_of(module: &str) -> Option<Spec> {
    match module {
        "Demandas" => Some((
            &["Fecha_Registro", "Fecha"],
            &["Tema", "Descripcion"],
            &["Actor/Grupo"],
        )),
        "Compromisos" => Some((&["Fecha"], &["Descripcion"], &["Actor/Entidad"])),
        "Narrativas" => Some((
            &["Fecha_Inicio", "Fecha_Observacion"],
            &["Tema", "Descripcion"],
            &["Actor_Relacionado"],
        )),
        "Alertas" => Some((&["Fecha"], &["Causa"], &["Actor", "Actor_Relacionado"])),
        "Eventos" => Some((
            &["Fecha"],
            &["Descripcion_Hecho", "Tipo_Evento"],
            &["Actor_Principal"],
        )),
        _ => None,
    }
}

/// `Object.prototype` properties: `SPECS[module]` finds them, and reading `spec.dates` of a
/// function or of `Object.prototype` then throws a `TypeError` in TypeScript.
const OBJECT_PROTOTYPE: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

/// `text(value)`: a trimmed string or number, `""` for anything else.
fn text(value: Option<&Value>) -> String {
    match value {
        Some(v @ (Value::String(_) | Value::Number(_))) => {
            js::trim(&to_js_string(Some(v))).to_owned()
        }
        _ => String::new(),
    }
}

/// `first(payload, keys)`: the first non-empty [`text`].
fn first(payload: &Map<String, Value>, keys: &[&str]) -> String {
    keys.iter()
        .map(|key| text(payload.get(*key)))
        .find(|value| !value.is_empty())
        .unwrap_or_default()
}

/// `severityOf`: rojo, crítico or muy alta 2; naranja or alta 1.5; anything else 1.
fn severity_of(value: &str) -> f64 {
    let v = fold(value);
    if v.contains("rojo") || v.contains("critic") || v.contains("muy alta") {
        2.0
    } else if v.contains("naranja") || v.contains("alta") || v.contains("alto") {
        1.5
    } else {
        1.0
    }
}

fn negative_tone(folded: &str) -> bool {
    ["critic", "negativ", "hostil", "advers"]
        .iter()
        .any(|w| folded.contains(w))
}

/// `/^descartad[oa]$/` on a folded value (folding leaves no line terminator).
fn discarded(folded: &str) -> bool {
    folded == "descartado" || folded == "descartada"
}

/// `ALERT_WEIGHT[fold(level)] ?? 1`. TypeScript reads the object literal, so `constructor` and
/// `__proto__` yield a function or `Object.prototype`; summing them makes a string whose
/// `Math.log1p` is `NaN`, which `NaN` reproduces.
fn alert_weight(folded_level: &str) -> f64 {
    match folded_level {
        "alta" => 2.0,
        "media" => 1.5,
        "constructor" | "__proto__" => f64::NAN,
        _ => 1.0,
    }
}

/// Display name of each unit key: the first spelling seen (`Names`).
#[derive(Debug, Default)]
pub struct Names {
    /// Key → display name.
    pub by_key: HashMap<String, String>,
}

impl Names {
    fn add(&mut self, prefix: char, name: &str) -> String {
        let key = format!("{prefix}:{}", fold(name));
        self.by_key
            .entry(key.clone())
            .or_insert_with(|| name.to_owned());
        key
    }
}

fn units_of(payload: &Map<String, Value>, actors: &[&str], names: &mut Names) -> Vec<String> {
    let mut units: Vec<String> = Vec::new();
    let locality = first(payload, &TERRITORY_FIELDS);
    if !locality.is_empty() {
        units.push(names.add('L', &locality));
    }
    for key in actors {
        for part in text(payload.get(*key)).split([';', ',']) {
            let name = js::trim(part);
            if utf16_len(name) > 1 {
                units.push(names.add('A', name));
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    units.retain(|u| seen.insert(u.clone()));
    units
}

/// `shortTitle(value, fallback)`: at most 120 UTF-16 units, cut to 117 plus `…`.
fn short_title(value: &str, fallback: &str) -> Title {
    let title = if value.is_empty() { fallback } else { value };
    if utf16_len(title) <= 120 {
        return Title {
            text: title.to_owned(),
            split: false,
        };
    }
    match utf16_prefix(title, 117) {
        Some(head) => Title {
            text: format!("{head}…"),
            split: false,
        },
        None => Title {
            text: format!("{}…", utf16_prefix(title, 116).unwrap_or_default()),
            split: true,
        },
    }
}

fn record_signals(record: &RiskRecord<'_>, names: &mut Names) -> Result<Vec<Signal>, EngineError> {
    let Some((dates, titles, actors)) = spec_of(record.module) else {
        if OBJECT_PROTOTYPE.contains(&record.module) {
            return Err(EngineError::UnsupportedValue(format!(
                "record module {} names an Object.prototype property; the TypeScript engine throws",
                record.module
            )));
        }
        return Ok(Vec::new());
    };
    let payload = record.payload;
    if record.module == "Alertas" && text(payload.get("Origen")) == GENERATED_ORIGIN {
        return Ok(Vec::new());
    }
    let due_date = if record.module == "Compromisos" {
        record_due_date(payload)
    } else {
        None
    };
    let Some(date) = day_of(&first(payload, dates)).or_else(|| due_date.clone()) else {
        return Ok(Vec::new());
    };
    let units = units_of(payload, actors, names);
    if units.is_empty() {
        return Ok(Vec::new());
    }
    let state = payload.get("Estado");
    let closed_day = record
        .updated_at
        .and_then(day_of)
        .unwrap_or_else(|| date.clone());
    let base = Signal {
        module: record.module.to_owned(),
        id: record.id.to_owned(),
        title: short_title(&first(payload, titles), record.id),
        date,
        kind: Kind::Event,
        units,
        weight: 1.0,
        closed_on: None,
        due_date,
        negative: false,
    };
    Ok(match record.module {
        "Demandas" => vec![Signal {
            kind: Kind::Demand,
            weight: if fold_value(payload.get("Prioridad")) == "alta" {
                1.5
            } else {
                1.0
            },
            closed_on: is_terminal_status(state).then_some(closed_day),
            ..base
        }],
        "Compromisos" => vec![Signal {
            kind: Kind::Commitment,
            closed_on: is_terminal_status(state).then_some(closed_day),
            ..base
        }],
        "Narrativas" => vec![Signal {
            kind: Kind::Narrative,
            negative: negative_tone(&fold_value(payload.get("Tono"))),
            ..base
        }],
        "Alertas" => {
            let discarded = discarded(&fold_value(state));
            let severity = severity_of(&first(payload, &["Nivel_Preliminar", "Nivel"]));
            let alert = Signal {
                kind: Kind::Alert,
                weight: severity,
                closed_on: discarded.then_some(closed_day),
                ..base
            };
            if severity >= 1.5 && !discarded {
                let escalation = Signal {
                    kind: Kind::Escalation,
                    weight: 1.0,
                    ..alert.clone()
                };
                vec![alert, escalation]
            } else {
                vec![alert]
            }
        }
        _ => {
            let severity = severity_of(&first(
                payload,
                &["Nivel_Preliminar", "Relevancia_Preliminar"],
            ));
            if severity >= 1.5 {
                let escalation = Signal {
                    kind: Kind::Escalation,
                    ..base.clone()
                };
                vec![base, escalation]
            } else {
                vec![base]
            }
        }
    })
}

fn alert_signals(alert: &RiskAlert<'_>, names: &mut Names) -> Vec<Signal> {
    let Some(date) = day_of(alert.created_at) else {
        return Vec::new();
    };
    let territory = js::trim(alert.territory.unwrap_or_default());
    if territory.is_empty() {
        return Vec::new();
    }
    let discarded = discarded(&fold(alert.status));
    let level = fold(alert.level);
    let signal = Signal {
        module: TERRITORIAL_ALERT_MODULE.to_owned(),
        id: alert.id.to_owned(),
        title: Title {
            text: format!("Alerta territorial {}", alert.level),
            split: false,
        },
        units: vec![names.add('L', territory)],
        kind: Kind::Alert,
        weight: alert_weight(&level),
        closed_on: discarded.then(|| {
            alert
                .reviewed_at
                .and_then(day_of)
                .unwrap_or_else(|| date.clone())
        }),
        date,
        due_date: None,
        negative: false,
    };
    if level == "alta" && !discarded {
        let escalation = Signal {
            kind: Kind::Escalation,
            weight: 1.0,
            ..signal.clone()
        };
        vec![signal, escalation]
    } else {
        vec![signal]
    }
}

/// `SignalIndex`: every signal dated on or before today, grouped by unit and sorted by date.
#[derive(Debug, Default)]
pub struct SignalIndex {
    /// The signals the unit lists point into.
    pub signals: Vec<Signal>,
    /// Unit keys in first-seen order (`byUnit.keys()`).
    pub units: Vec<String>,
    /// Per unit (parallel to `units`), indices into `signals` sorted by date.
    pub by_unit: Vec<Vec<usize>>,
    /// Display name of each unit key.
    pub names: HashMap<String, String>,
    /// Earliest signal day, `None` without signals.
    pub first_day: Option<String>,
}

impl SignalIndex {
    /// The signals of a unit (by position in `units`), sorted by date.
    pub fn of(&self, unit: usize) -> impl Iterator<Item = &Signal> {
        self.by_unit
            .get(unit)
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .filter_map(|&i| self.signals.get(i))
    }
}

/// `indexSignals(input)`.
///
/// # Errors
/// `UnsupportedValue` for a record whose module names an `Object.prototype` property.
pub fn index_signals(input: &RiskInput<'_>) -> Result<SignalIndex, EngineError> {
    let mut names = Names::default();
    let mut all = Vec::new();
    for record in &input.records {
        all.extend(record_signals(record, &mut names)?);
    }
    for alert in &input.alerts {
        all.extend(alert_signals(alert, &mut names));
    }
    let signals: Vec<Signal> = all
        .into_iter()
        .filter(|s| s.date.as_str() <= input.today)
        .collect();
    let mut units: Vec<String> = Vec::new();
    let mut by_unit: Vec<Vec<usize>> = Vec::new();
    let mut position: HashMap<&str, usize> = HashMap::new();
    for (i, signal) in signals.iter().enumerate() {
        for unit in &signal.units {
            let at = *position.entry(unit.as_str()).or_insert_with(|| {
                units.push(unit.clone());
                by_unit.push(Vec::new());
                by_unit.len() - 1
            });
            if let Some(list) = by_unit.get_mut(at) {
                list.push(i);
            }
        }
    }
    for list in &mut by_unit {
        // Stable, like Array.prototype.sort; `localeCompare` on `YYYY-MM-DD` is the byte order.
        list.sort_by(|&a, &b| {
            let date = |i: usize| signals.get(i).map_or("", |s| s.date.as_str());
            date(a).cmp(date(b))
        });
    }
    let first_day = signals
        .iter()
        .map(|s| s.date.as_str())
        .min()
        .map(str::to_owned);
    Ok(SignalIndex {
        signals,
        units,
        by_unit,
        names: names.by_key,
        first_day,
    })
}
