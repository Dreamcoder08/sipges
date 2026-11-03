//! Integrated analysis (app.py:881, RC 1.9): candidate links plus a draft action plan, a port of
//! `apps/api/src/contexts/analytics/domain/integrated.ts` with byte-identical `JSON.stringify` output.

use serde_json::{Map, Value, json};
use sipges_analytics_common::{
    EXTENDED_MODULES, EngineError, Extended, extended_records, records_field, str_field,
};

const LIMITATIONS: [&str; 4] = [
    "Las asociaciones textuales son candidatas, no relaciones verificadas. No se hacen inferencias personales sobre los actores.",
    "Los escenarios son condicionales, no pronósticos ni probabilidades. No se modifica el IRSA.",
    "No se crea ningún compromiso, se asignan presupuestos ni se califica legitimidad sin revisión.",
    "Los resultados proceden solo de registros del proyecto y requieren auditoría de fuentes y control de acceso.",
];

fn scenarios() -> Value {
    json!([
        {
            "tipo": "Escenario de mejora",
            "supuesto": "Los actores revisan discrepancias, se verifican fuentes y se acuerdan pasos con responsables.",
            "indicadores_a_observar": ["Hechos contrastados", "Cumplimiento de compromisos", "Participación efectiva"],
        },
        {
            "tipo": "Escenario de continuidad",
            "supuesto": "Permanecen asuntos abiertos y no se actualizan datos ni acuerdos.",
            "indicadores_a_observar": ["Antigüedad de temas abiertos", "Calidad de evidencia", "Siguientes pasos vencidos"],
        },
        {
            "tipo": "Escenario de deterioro",
            "supuesto": "Persisten discrepancias y se acumulan compromisos incumplidos corroborados.",
            "indicadores_a_observar": ["Alertas comprobadas", "Demandas pendientes", "Cambios documentados en el relacionamiento"],
        },
    ])
}

/// Copies `card[from]` to `out[to]` when present (`JSON.stringify` drops `undefined` properties).
fn copy(out: &mut Map<String, Value>, to: &str, card: &Value, from: &str) {
    if let Some(value) = card.get(from) {
        out.insert(to.to_owned(), value.clone());
    }
}

/// `integratedAnalysis(r, projectId, generatedAt)`.
///
/// # Errors
/// Propagates the consensus and candidate-link engines' errors.
pub fn integrated_analysis(
    r: &Extended,
    project_id: &str,
    generated_at: &str,
) -> Result<Value, EngineError> {
    let pairs = sipges_candidate_links::candidate_pairs(r)?;
    let pairs = Value::from(pairs);
    let consensus = sipges_consensus::automated_consensus(r, project_id, generated_at)?;
    let cards = consensus
        .get("recommendations")
        .and_then(Value::as_array)
        .ok_or_else(|| EngineError::input("consensus has no recommendations"))?;
    let actions: Vec<Value> = cards
        .iter()
        .enumerate()
        .map(|(i, card)| {
            let mut action = Map::new();
            action.insert("numero".into(), Value::from(i + 1));
            copy(&mut action, "accion", card, "accion_sugerida");
            copy(&mut action, "objetivo", card, "titulo");
            copy(&mut action, "fundamento", card, "motivo");
            copy(&mut action, "registros", card, "registros_relacionados");
            copy(
                &mut action,
                "prioridad_orientativa",
                card,
                "prioridad_orientativa",
            );
            action.insert("responsable".into(), "Por asignar tras revisión".into());
            action.insert("plazo".into(), "Por acordar".into());
            action.insert("estado".into(), "Borrador automático — no aprobado".into());
            Value::Object(action)
        })
        .collect();
    let strategic_records: usize = EXTENDED_MODULES
        .iter()
        .map(|(key, _)| r.get(key).len())
        .sum();
    let pair_count = pairs.as_array().map_or(0, Vec::len);
    let mut summary = Map::new();
    summary.insert("cruces_candidatos".into(), Value::from(pair_count));
    summary.insert("acciones_sugeridas".into(), Value::from(actions.len()));
    summary.insert(
        "registros_estrategicos".into(),
        Value::from(strategic_records),
    );
    let mut out = Map::new();
    out.insert("project_id".into(), project_id.into());
    out.insert("generated_at".into(), generated_at.into());
    out.insert("version".into(), "1.9".into());
    out.insert("summary".into(), Value::Object(summary));
    out.insert("candidate_links".into(), pairs);
    out.insert("action_plan".into(), Value::Array(actions));
    out.insert("scenarios".into(), scenarios());
    out.insert("limitations".into(), Value::from(LIMITATIONS.to_vec()));
    Ok(Value::Object(out))
}

/// Runs an `integrated` request: `records` (`RecordsByModule`), `project_id`, `generated_at`.
///
/// # Errors
/// `InvalidInput` for a malformed `records`, `project_id` or `generated_at`.
pub fn run(request: &Map<String, Value>) -> Result<Value, EngineError> {
    let r = extended_records(&records_field(request))?;
    integrated_analysis(
        &r,
        str_field(request, "project_id")?,
        str_field(request, "generated_at")?,
    )
}
