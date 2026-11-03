//! Port of `apps/api/src/contexts/intelligence/domain/classifier.ts`: the calibrated lexical
//! classifier of a territorial record into one SIPGES dimension (app.py:1207-1320, v0.5.1).

use serde_json::{Map, Value, json};
use sipges_analytics_common::js;

use crate::python::{Form, fold_marks, py_json_dumps, round_half_even};

/// A dimension: code, label, strong phrases, weak phrases (`DIMENSIONS` order, `CLASSIFIER_LEXICON`
/// and `DIMENSION_LABELS`).
struct Dimension {
    code: &'static str,
    label: &'static str,
    strong: &'static [&'static str],
    weak: &'static [&'static str],
}

const G: usize = 0;
const A: usize = 1;
const D: usize = 2;
const N: usize = 3;
const E: usize = 4;
const I: usize = 5;

const DIMENSIONS: [Dimension; 6] = [
    Dimension {
        code: "G",
        label: "Gobernanza y representación",
        strong: &[
            "representacion legal",
            "facultades",
            "gobernanza",
            "padron",
            "eleccion",
            "interlocucion",
            "junta transitoria",
            "administrador judicial",
            "legitimidad comunal",
            "organo comunal",
            "representacion fragmentada",
        ],
        weak: &[
            "comunal",
            "judicial",
            "sunarp",
            "bdpi",
            "consulta previa",
            "directiva",
            "fundacion comunal",
        ],
    },
    Dimension {
        code: "A",
        label: "Actores e influencia",
        strong: &[
            "mapa de actores",
            "capacidad de influencia",
            "influencia alta",
            "capacidad de movilizacion",
            "movilizacion alta",
            "alianza",
            "actor critico",
            "liderazgo",
        ],
        weak: &[
            "actor",
            "organizacion",
            "convocatoria",
            "relacionamiento",
            "roles",
        ],
    },
    Dimension {
        code: "D",
        label: "Demandas y compromisos",
        strong: &[
            "demanda",
            "demandas",
            "solicitan",
            "solicitud",
            "compromiso",
            "empleo",
            "proveedores",
            "beneficios",
            "capacitacion",
            "expectativas",
        ],
        weak: &["agenda", "atencion", "pedido", "requerimiento"],
    },
    Dimension {
        code: "N",
        label: "Narrativas y señales digitales",
        strong: &[
            "narrativa",
            "facebook",
            "medios digitales",
            "redes sociales",
            "notas periodisticas",
            "prensa",
            "publicaciones",
            "tono negativo",
            "no verificado",
            "desinformacion",
        ],
        weak: &[
            "controversia",
            "exposicion publica",
            "reputacional",
            "comentarios",
        ],
    },
    Dimension {
        code: "E",
        label: "Ambiental-territorial",
        strong: &[
            "agua",
            "pesca",
            "maricultura",
            "biodiversidad",
            "pozo",
            "ganadero",
            "ganado",
            "servidumbre",
            "derechos superficiales",
            "territorio",
            "ambiental",
        ],
        weak: &[
            "saneamiento",
            "acceso",
            "rutas",
            "agricultor",
            "agricolas",
            "bahia",
            "transito",
        ],
    },
    Dimension {
        code: "I",
        label: "Institucional y trazabilidad",
        strong: &[
            "convocatoria formal",
            "cargos firmados",
            "carta de invitacion",
            "comunicacion institucional",
            "trazabilidad",
            "coordinacion institucional",
            "oficio",
            "subprefectura",
            "proinversion",
            "minem",
            "fase de estructuracion",
            "contrato/bases",
            "concurso internacional",
            "adjudicacion",
        ],
        weak: &[
            "institucional",
            "resolucion",
            "coordinacion",
            "municipalidad",
            "cronograma",
            "hitos",
            "presentacion",
        ],
    },
];

const NOTE: &str = "Sugerencia automática calibrada. No constituye referencia experta ni resultado final de tesis; requiere validación.";

#[derive(Default)]
struct Scores {
    scores: [f64; 6],
    evidence: [Vec<(&'static str, f64)>; 6],
}

impl Scores {
    fn add(&mut self, d: usize, signal: &'static str, weight: f64) {
        if let (Some(score), Some(evidence)) = (self.scores.get_mut(d), self.evidence.get_mut(d)) {
            *score += weight;
            evidence.push((signal, weight));
        }
    }

    fn score(&self, d: usize) -> f64 {
        self.scores.get(d).copied().unwrap_or(0.0)
    }
}

/// Lexicon phrases and general context rules over the folded record text.
fn score(text: &str) -> Scores {
    let has = |w: &str| text.contains(w);
    let any = |words: &[&str]| words.iter().any(|w| has(w));
    let mut s = Scores::default();

    for (d, dim) in DIMENSIONS.iter().enumerate() {
        for phrase in dim.strong {
            if has(phrase) {
                s.add(d, phrase, 4.0);
            }
        }
        for phrase in dim.weak {
            if has(phrase) {
                s.add(d, phrase, 1.5);
            }
        }
    }

    // General context rules; they never use case ids or the expected dimension.
    if any(&[
        "facebook",
        "medios digitales",
        "notas periodisticas",
        "prensa",
        "redes sociales",
    ]) {
        s.add(N, "canal digital/periodístico", 5.0);
    }
    if any(&[
        "convocatoria formal",
        "cargos firmados",
        "fase de estructuracion",
        "comunicacion institucional",
    ]) {
        s.add(I, "acto/comunicación institucional trazable", 5.0);
    }
    if has("mapa de actores") || (has("influencia") && has("movilizacion")) {
        s.add(A, "influencia + movilización / mapa de actores", 5.0);
    }
    if has("demanda") || has("demandas") {
        s.add(D, "demanda explícita", 4.0);
    }
    if any(&[
        "agua",
        "pozo",
        "pesca",
        "maricultura",
        "derechos superficiales",
    ]) {
        s.add(E, "componente ambiental/territorial explícito", 3.0);
    }
    if has("administrador judicial") && (has("facultades") || has("representacion legal")) {
        s.add(G, "facultades + representación/interlocución", 6.0);
    }
    if has("mina de sal") && any(&["enfrentamiento", "control", "posesion"]) {
        s.add(G, "disputa territorial por control/posesión", 3.0);
    }

    s
}

/// `classifyRecord(payload)`.
#[must_use]
pub fn classify(payload: &Value) -> Value {
    let text = fold_marks(&py_json_dumps(payload), Form::Nfd);
    let any = |words: &[&str]| words.iter().any(|w| text.contains(w));
    let s = score(&text);

    // Stable sort: ties keep the G, A, D, N, E, I order like Python's sorted().
    let mut ordered: Vec<usize> = (0..DIMENSIONS.len()).collect();
    ordered.sort_by(|&a, &b| s.score(b).total_cmp(&s.score(a)));
    let dim = ordered.first().copied().unwrap_or(G);
    let top = s.score(dim);
    let second = s.score(ordered.get(1).copied().unwrap_or(A));
    let margin = (top - second).max(0.0);
    let confidence = if top <= 0.0 {
        40.0
    } else {
        round_half_even(
            94f64.min(55.0 + (top * 1.5).min(24.0) + (margin * 1.5).min(15.0)),
            0,
        )
    };

    let critical = any(&[
        "enfrentamiento",
        "bloqueo",
        "violencia",
        "detenid",
        "riesgo alto",
        "afectacion critica",
        "condicion critica",
    ]);
    let extreme = any(&["fallecid", "grave violencia", "lesiones graves"]);
    let mut severity = "Amarillo";
    if critical {
        severity = "Naranja";
    }
    if extreme && dim != N {
        severity = "Rojo";
    }

    let mut scores = Map::new();
    let mut evidence = Map::new();
    for (d, info) in DIMENSIONS.iter().enumerate() {
        scores.insert(
            info.code.to_owned(),
            js::number(round_half_even(s.score(d), 2)),
        );
        let signals: Vec<Value> = s
            .evidence
            .get(d)
            .map(|e| {
                e.iter()
                    .map(
                        |&(signal, weight)| json!({"signal": signal, "weight": js::number(weight)}),
                    )
                    .collect()
            })
            .unwrap_or_default();
        evidence.insert(info.code.to_owned(), Value::Array(signals));
    }
    let info = DIMENSIONS.get(dim).unwrap_or(&DIMENSIONS[G]);
    let margin_rounded = round_half_even(margin, 2);

    json!({
        "classifier_version": "0.5.1-calibracion",
        "dimension": info.code,
        "dimension_label": info.label,
        "confidence": js::number(confidence),
        "nivel_sugerido": severity,
        "scores": scores,
        "margin": js::number(margin_rounded),
        "evidence": evidence,
        "review_required": confidence < 70.0 || margin < 3.0,
        "nota": NOTE,
    })
}
