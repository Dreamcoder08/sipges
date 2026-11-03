//! Port of `apps/api/src/contexts/intelligence/domain/text-analysis.ts`: keyword analysis of
//! transcribed public text (app.py:1910-2003, RC 2.4), `cosine` and `isPublicHttpUrl`.

use serde_json::{Map, Value, json};
use sipges_analytics_common::{js, py_str, py_truthy};

use crate::python::{Form, fold_marks, has_whole_word, slice_code_points};
use crate::sha256::sha256_hex;

/// `TEXT_TERMS`, in key order.
const TEXT_TERMS: [(&str, &[&str]); 7] = [
    (
        "Gobernanza y representación",
        &[
            "directiva",
            "eleccion",
            "presidente",
            "asamblea",
            "representacion",
            "comunidad campesina",
            "administracion",
            "dirigente",
        ],
    ),
    (
        "Territorio y tierras",
        &[
            "territorio",
            "tierras",
            "concesion",
            "servidumbre",
            "predio",
            "linderos",
            "ocupacion",
        ],
    ),
    (
        "Empleo y economía local",
        &[
            "empleo",
            "trabajo",
            "contratacion",
            "proveedor",
            "beneficio",
            "salario",
            "inversion",
        ],
    ),
    (
        "Ambiente y agua",
        &[
            "agua",
            "contaminacion",
            "ambiente",
            "impacto",
            "polvo",
            "residuo",
            "ecosistema",
        ],
    ),
    (
        "Diálogo y compromisos",
        &[
            "dialogo",
            "reunion",
            "acuerdo",
            "compromiso",
            "mesa de trabajo",
            "informacion",
            "consulta",
        ],
    ),
    (
        "Protesta y conflictividad",
        &[
            "protesta",
            "paro",
            "bloqueo",
            "movilizacion",
            "conflicto",
            "denuncia",
            "rechazo",
        ],
    ),
    (
        "Seguridad y emergencias",
        &[
            "accidente",
            "amenaza",
            "riesgo",
            "emergencia",
            "seguridad",
            "evacuacion",
        ],
    ),
];

/// `TEXT_SIGNALS`, in key order.
const TEXT_SIGNALS: [(&str, &[&str]); 4] = [
    (
        "Movilización anunciada",
        &["paro", "marcha", "movilizacion", "bloqueo", "planton"],
    ),
    (
        "Demanda o reclamo",
        &[
            "exigimos",
            "reclamamos",
            "solicitamos",
            "demanda",
            "incumplimiento",
        ],
    ),
    (
        "Convocatoria a reunión",
        &["convocatoria", "asamblea", "reunion", "mesa de dialogo"],
    ),
    (
        "Información no corroborada",
        &[
            "dicen que",
            "se rumorea",
            "supuestamente",
            "trascendio",
            "al parecer",
        ],
    ),
];

/// `MAX_TEXT_LENGTH`, in code points.
pub const MAX_TEXT_LENGTH: usize = 20_000;

const LIMITATIONS: [&str; 4] = [
    "No valida la autenticidad ni el contenido del enlace.",
    "No permite afirmar causalidad, sentimientos, intenciones o riesgo individual.",
    "Confirmar con fuentes y revisión.",
    "El texto enviado no se guarda por este endpoint.",
];

struct Topic {
    tema: &'static str,
    terms: &'static [&'static str],
    found: Vec<&'static str>,
}

/// The `terms` that occur in `norm` as whole words, in list order.
fn whole_words(norm: &str, terms: &'static [&'static str]) -> Vec<&'static str> {
    terms
        .iter()
        .copied()
        .filter(|w| has_whole_word(norm, w))
        .collect()
}

/// Per topic, the narratives whose folded `Tema Descripcion` contains any of its terms. Every
/// narrative of the tenant counts: the tenant is the project (S13).
fn narrative_counts(topics: &[Topic], narratives: &[&Map<String, Value>]) -> Vec<usize> {
    let mut counts = vec![0usize; topics.len()];
    for record in narratives {
        let field = |k: &str| {
            let v = record.get(k);
            if py_truthy(v) {
                py_str(v)
            } else {
                String::new()
            }
        };
        let rt = fold_marks(
            &format!("{} {}", field("Tema"), field("Descripcion")),
            Form::Nfkd,
        );
        for (count, topic) in counts.iter_mut().zip(topics) {
            if topic.terms.iter().any(|w| rt.contains(w)) {
                *count += 1;
            }
        }
    }
    counts
}

/// `suggested_actions`.
fn suggestions(signals: &[(&str, Vec<&str>)], has_topics: bool) -> Vec<&'static str> {
    let has = |name: &str| signals.iter().any(|(s, _)| *s == name);
    let mut out = Vec::new();
    if has("Movilización anunciada") {
        out.push(
            "Verificar convocatoria, fecha, lugar y fuente antes de actualizar el nivel de riesgo.",
        );
    }
    if has("Demanda o reclamo") {
        out.push("Revisar si existe un compromiso o demanda vinculada en el registro territorial.");
    }
    if has("Información no corroborada") {
        out.push("Solicitar corroboración documental antes de difundir o escalar el contenido.");
    }
    if has_topics {
        out.push(
            "Contrastar el hallazgo con fuentes, actores institucionales y evidencia de campo.",
        );
    }
    if out.is_empty() {
        out.push(
            "Registrar y verificar contexto; no hay términos suficientes para emitir una alerta temática.",
        );
    }
    out
}

/// `analyzeText(input, narratives, sha256)`: the `{ok, value}` / `{ok, error: {kind}}` envelope.
#[must_use]
pub fn analyze_text(
    text: &str,
    project_id: &str,
    source_url: &str,
    narratives: &[&Map<String, Value>],
) -> Value {
    let content = js::trim(text);
    if content.is_empty() {
        return json!({"ok": false, "error": {"kind": "empty"}});
    }
    let chars = content.chars().count();
    if chars > MAX_TEXT_LENGTH {
        return json!({"ok": false, "error": {"kind": "too_long"}});
    }
    let norm = fold_marks(content, Form::Nfkd);

    let mut topics: Vec<Topic> = TEXT_TERMS
        .iter()
        .filter_map(|&(tema, terms)| {
            let found = whole_words(&norm, terms);
            (!found.is_empty()).then_some(Topic { tema, terms, found })
        })
        .collect();
    // Count descending, then theme name; every name is in the BMP, so byte order is UTF-16 order.
    topics.sort_by(|a, b| b.found.len().cmp(&a.found.len()).then(a.tema.cmp(b.tema)));

    let signals: Vec<(&str, Vec<&str>)> = TEXT_SIGNALS
        .iter()
        .filter_map(|&(senal, terms)| {
            let found = whole_words(&norm, terms);
            (!found.is_empty()).then_some((senal, found))
        })
        .collect();

    // No authorship, truthfulness, personal threat or conflict probability is inferred.
    let score = ((signals.len() * 15).min(50) + (topics.len() * 6).min(30)).min(100);
    let level = if score >= 65 {
        "Alta"
    } else if score >= 35 {
        "Media"
    } else {
        "Baja"
    };
    let counts = narrative_counts(&topics, narratives);
    let suggestions = suggestions(&signals, !topics.is_empty());

    let topics_json: Vec<Value> = topics
        .iter()
        .map(|t| json!({"tema": t.tema, "terminos_detectados": t.found, "cantidad": t.found.len()}))
        .collect();
    let signals_json: Vec<Value> = signals
        .iter()
        .map(|(s, found)| json!({"senal": s, "terminos_detectados": found}))
        .collect();
    let comparison: Vec<Value> = topics
        .iter()
        .zip(&counts)
        .map(|(t, n)| json!({"tema": t.tema, "registros_relacionados_por_palabras": n}))
        .collect();

    json!({
        "ok": true,
        "value": {
            "version": "2.4",
            "project_id": project_id,
            "source_url": source_url,
            "analyzed_chars": chars,
            "topics": topics_json,
            "signals": signals_json,
            "orientation": {
                "score": score,
                "level": level,
                "meaning": "Prioridad de revisión textual, no probabilidad de conflicto ni valoración de una persona.",
            },
            "project_comparison": comparison,
            "suggested_actions": suggestions,
            "evidence": {
                "fragment": slice_code_points(content, 500),
                "sha256": sha256_hex(content.as_bytes()),
            },
            "method": "Coincidencia determinista de palabras clave normalizadas; sin inteligencia artificial generativa ni extracción automática.",
            "limitations": LIMITATIONS,
        },
    })
}

/// `cosine(a, b)`: vectors of different length are unrelated (0).
#[must_use]
pub fn cosine(a: &[f64], b: &[f64]) -> f64 {
    if a.len() != b.len() {
        return 0.0;
    }
    let (mut dot, mut na, mut nb) = (0.0, 0.0, 0.0);
    for (&x, &y) in a.iter().zip(b) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    // `na && nb`: 0 and NaN are falsy.
    if na != 0.0 && !na.is_nan() && nb != 0.0 && !nb.is_nan() {
        dot / (na.sqrt() * nb.sqrt())
    } else {
        0.0
    }
}

/// `isPublicHttpUrl(url)`: `/^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/` matches with an `http`
/// or `https` scheme (any case) and a non-empty network location.
#[must_use]
pub fn is_public_http_url(url: &str) -> bool {
    let scheme_end = url
        .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')))
        .unwrap_or(url.len());
    let (scheme, rest) = url.split_at(scheme_end);
    if !scheme.starts_with(|c: char| c.is_ascii_alphabetic()) {
        return false;
    }
    let Some(after) = rest.strip_prefix("://") else {
        return false;
    };
    let scheme = scheme.to_ascii_lowercase();
    (scheme == "http" || scheme == "https")
        && !after.starts_with(['/', '?', '#'])
        && !after.is_empty()
}
