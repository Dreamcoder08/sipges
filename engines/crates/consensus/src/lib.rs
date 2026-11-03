//! Consensus engine: port of `automatedConsensus` in
//! `apps/api/src/contexts/analytics/domain/consensus.ts` (app.py:745, RC 1.8). Deterministic,
//! traceable recommendation cards; drafts, never agreements, diagnoses or validated facts.
//!
//! `js::stringify(&run(request)?)` equals the TypeScript
//! `JSON.stringify(automatedConsensus(extendedRecords(records), project_id, generated_at))`.

use serde_json::{Map, Value};
pub use sipges_analytics_common::EngineError;
use sipges_analytics_common::{
    AARC_DIMENSIONS, DIALOGUE_CLOSED, Extended, FACT_CLOSED, OPPORTUNITY_CLOSED, Record,
    extended_records, js, py_get, py_str, py_strip, records_field, str_field,
};

const LIMITATIONS: [&str; 3] = [
    "Los disparadores indican faltantes de registros, no defectos reales de personas ni instituciones.",
    "El módulo no modifica IRSA, no aprueba acuerdos, no compromete presupuesto y no produce diagnósticos de legitimidad.",
    "Los registros deben tener fuentes, controles de acceso y revisión profesional antes del uso institucional.",
];

const ALTA: &str = "Alta";
const MEDIA: &str = "Media";

/// `lower`: `pyStr(value).toLowerCase()`.
fn lower(record: &Record, key: &str) -> String {
    py_str(Some(py_get(record, key))).to_lowercase()
}

/// `!pyStrip(pyGet(x, key))`.
fn blank(record: &Record, key: &str) -> bool {
    py_strip(Some(py_get(record, key))).is_empty()
}

/// The record id (`x._id`); `extendedRecords` always stores it as a string.
fn id_of(record: &Record) -> String {
    match record.get("_id") {
        Some(Value::String(s)) => s.clone(),
        other => py_str(other),
    }
}

/// One `ConsensusCard` before serialization.
struct Card {
    tipo: &'static str,
    titulo: &'static str,
    motivo: String,
    accion_sugerida: &'static str,
    origen: String,
    registros_relacionados: Vec<String>,
    prioridad_orientativa: &'static str,
}

impl Card {
    fn into_value(self) -> Value {
        let mut out = Map::new();
        out.insert("tipo".into(), self.tipo.into());
        out.insert("titulo".into(), self.titulo.into());
        out.insert("motivo".into(), self.motivo.into());
        out.insert("accion_sugerida".into(), self.accion_sugerida.into());
        out.insert("origen".into(), self.origen.into());
        out.insert(
            "registros_relacionados".into(),
            Value::Array(
                self.registros_relacionados
                    .into_iter()
                    .map(Value::String)
                    .collect(),
            ),
        );
        out.insert(
            "prioridad_orientativa".into(),
            self.prioridad_orientativa.into(),
        );
        out.insert(
            "estado".into(),
            "Propuesta automática; pendiente de revisión".into(),
        );
        out.insert(
            "autorizacion".into(),
            "No constituye acuerdo ni compromiso".into(),
        );
        Value::Object(out)
    }
}

/// The card list of `collectCards`, deduplicated by (type, origin, title) in first-seen order.
#[derive(Default)]
struct Cards(Vec<Card>);

impl Cards {
    #[allow(clippy::too_many_arguments)]
    fn add(
        &mut self,
        tipo: &'static str,
        titulo: &'static str,
        motivo: String,
        accion_sugerida: &'static str,
        origen: String,
        registros_relacionados: Vec<String>,
        prioridad_orientativa: &'static str,
    ) {
        if self
            .0
            .iter()
            .any(|c| c.tipo == tipo && c.origen == origen && c.titulo == titulo)
        {
            return;
        }
        self.0.push(Card {
            tipo,
            titulo,
            motivo,
            accion_sugerida,
            origen,
            registros_relacionados,
            prioridad_orientativa,
        });
    }
}

fn facts(cards: &mut Cards, r: &Extended) {
    for x in &r.hechos {
        let id = id_of(x);
        if !FACT_CLOSED.contains(&js::trim(&lower(x, "Estado"))) {
            cards.add(
                "Hechos compartidos",
                "Preparar verificación conjunta de información",
                "El asunto consta como no validado; no se debe resolver una controversia a partir de una sola versión.".into(),
                "Acordar preguntas, fuentes, metodología, responsables y criterios de validación con los actores participantes.",
                format!("hechos/{id}"),
                vec![id.clone()],
                ALTA,
            );
        }
        if blank(x, "Fuente_ID") {
            cards.add(
                "Calidad de evidencia",
                "Completar fuentes de la controversia",
                "El registro no tiene Fuente_ID.".into(),
                "Vincular al menos una evidencia rastreable antes de emitir conclusiones.",
                format!("hechos/{id}"),
                vec![id.clone()],
                ALTA,
            );
        }
    }
}

fn interests(cards: &mut Cards, r: &Extended) {
    for x in &r.intereses {
        let id = id_of(x);
        let actor = py_strip(Some(py_get(x, "Actor")));
        let actor = if actor.is_empty() { id.clone() } else { actor };
        if blank(x, "Interes") {
            cards.add(
                "Negociación por intereses",
                "Explorar intereses expresados, sin inferirlos",
                format!("El actor {actor} tiene una ficha sin interés documentado."),
                "Programar escucha consultiva y registrar los intereses declarados con evidencia y consentimiento.",
                format!("intereses/{id}"),
                vec![id.clone()],
                MEDIA,
            );
        }
        if blank(x, "Mandato") {
            cards.add(
                "Representatividad",
                "Verificar mandato antes de acuerdos formales",
                format!("La ficha de {actor} no registra sustento documental de mandato."),
                "Solicitar documentación de representación y registrar su vigencia; no asumir falta de legitimidad.",
                format!("intereses/{id}"),
                vec![id.clone()],
                ALTA,
            );
        }
        if !blank(x, "Preocupacion") && blank(x, "Fuente_ID") {
            cards.add(
                "Información compartida",
                "Documentar origen de preocupación",
                "Se registró una preocupación sin fuente trazable.".into(),
                "Documentar declaración original, fecha, contexto y autorización de uso.",
                format!("intereses/{id}"),
                vec![id.clone()],
                MEDIA,
            );
        }
    }
}

fn dialogues(cards: &mut Cards, r: &Extended) {
    for x in &r.dialogos {
        let id = id_of(x);
        if DIALOGUE_CLOSED.contains(&lower(x, "Estado").as_str()) {
            continue;
        }
        if blank(x, "Proximo_Paso") || blank(x, "Responsable") {
            cards.add(
                "Arquitectura de consenso",
                "Definir seguimiento del diálogo",
                "El proceso abierto no tiene responsable o siguiente paso completo.".into(),
                "Acordar responsable, plazo, mecanismo de rendición de cuentas y forma de gestionar desacuerdos.",
                format!("dialogos/{id}"),
                vec![id.clone()],
                ALTA,
            );
        }
        if blank(x, "Fuente_ID") {
            cards.add(
                "Trazabilidad",
                "Vincular acta o evidencia del proceso",
                "El proceso de diálogo no presenta una fuente identificada.".into(),
                "Adjuntar acta, registro consentido o evidencia verificable.",
                format!("dialogos/{id}"),
                vec![id.clone()],
                MEDIA,
            );
        }
    }
}

fn opportunities(cards: &mut Cards, r: &Extended) {
    for x in &r.oportunidades {
        let id = id_of(x);
        if OPPORTUNITY_CLOSED.contains(&lower(x, "Estado").as_str()) {
            continue;
        }
        if blank(x, "Viabilidad") || blank(x, "Restricciones") {
            cards.add(
                "Mutual Gains / valor compartido",
                "Examinar viabilidad de oportunidad",
                "La oportunidad registrada necesita evaluación técnica, legal o presupuestal.".into(),
                "Contrastar beneficios para cada actor, restricciones, financiamiento y opciones alternativas; no presentarla como promesa.",
                format!("oportunidades/{id}"),
                vec![id.clone()],
                MEDIA,
            );
        }
        if blank(x, "Responsable") {
            cards.add(
                "Gobernanza adaptativa",
                "Asignar responsable de evaluación",
                "La oportunidad abierta no tiene un responsable de seguimiento documentado.".into(),
                "Definir responsable de evaluar, sin convertir una propuesta en compromiso.",
                format!("oportunidades/{id}"),
                vec![id.clone()],
                MEDIA,
            );
        }
    }
}

fn aarc(cards: &mut Cards, r: &Extended) {
    for x in &r.aarc {
        let id = id_of(x);
        // AARC_DIMENSIONS rows are [key, label]: the field read is the first element.
        let missing: Vec<&str> = AARC_DIMENSIONS
            .iter()
            .filter(|(key, _)| blank(x, key))
            .map(|(_, label)| *label)
            .collect();
        if !missing.is_empty() {
            cards.add(
                "AARC / relacionamiento",
                "Completar evaluación cualitativa AARC",
                format!("Dimensiones sin documentación: {}.", missing.join(", ")),
                "Recoger observaciones verificables con participación de los involucrados; evitar una puntuación ficticia.",
                format!("aarc/{id}"),
                vec![id.clone()],
                MEDIA,
            );
        } else if blank(x, "Evidencia") {
            cards.add(
                "AARC / evidencia",
                "Sustentar evaluación AARC",
                "La evaluación registra las cuatro dimensiones sin evidencia indicada.".into(),
                "Vincular hechos observables, fuentes y fecha de evaluación.",
                format!("aarc/{id}"),
                vec![id.clone()],
                MEDIA,
            );
        }
    }
}

fn cross_module(cards: &mut Cards, r: &Extended) {
    if !r.intereses.is_empty() && !r.oportunidades.is_empty() {
        let related = r
            .intereses
            .iter()
            .take(3)
            .chain(r.oportunidades.iter().take(3))
            .map(id_of)
            .collect();
        cards.add(
            "Integración intereses-valor",
            "Contrastar intereses con cartera de oportunidades",
            "Existen fichas de intereses y oportunidades para el mismo proyecto; no se presume coincidencia ni apoyo.".into(),
            "Revisar conjuntamente la correspondencia y documentar coincidencias, desacuerdos y restricciones antes de generar opciones.",
            "intereses+oportunidades".into(),
            related,
            MEDIA,
        );
    }
    if let (Some(fact), Some(dialogue)) = (r.hechos.first(), r.dialogos.first()) {
        cards.add(
            "Integración hechos-diálogo",
            "Incluir controversias verificables en la agenda de diálogo",
            "El proyecto registra tanto procesos de diálogo como asuntos sujetos a verificación.".into(),
            "Preguntar a los participantes qué hechos necesitan verificar juntos y acordar un procedimiento transparente.",
            "hechos+dialogos".into(),
            vec![id_of(fact), id_of(dialogue)],
            MEDIA,
        );
    }
}

/// `automatedConsensus(r, projectId, generatedAt)`.
///
/// # Errors
/// None today; the `Result` keeps the engine signature uniform with the other analytics engines.
pub fn automated_consensus(
    r: &Extended,
    project_id: &str,
    generated_at: &str,
) -> Result<Value, EngineError> {
    let mut cards = Cards::default();
    facts(&mut cards, r);
    interests(&mut cards, r);
    dialogues(&mut cards, r);
    opportunities(&mut cards, r);
    aarc(&mut cards, r);
    cross_module(&mut cards, r);

    let total = cards.0.len();
    let alta = cards
        .0
        .iter()
        .filter(|c| c.prioridad_orientativa == ALTA)
        .count();
    let mut summary = Map::new();
    summary.insert("total".into(), Value::from(total));
    summary.insert("alta".into(), Value::from(alta));

    let mut out = Map::new();
    out.insert("project_id".into(), project_id.into());
    out.insert("generated_at".into(), generated_at.into());
    out.insert(
        "method".into(),
        "reglas trazables v1.8 (sin inferencia predictiva ni IA generativa)".into(),
    );
    out.insert("counts".into(), r.counts());
    out.insert(
        "recommendations".into(),
        Value::Array(cards.0.into_iter().map(Card::into_value).collect()),
    );
    out.insert("summary".into(), Value::Object(summary));
    out.insert(
        "limitations".into(),
        Value::Array(LIMITATIONS.iter().map(|&s| s.into()).collect()),
    );
    Ok(Value::Object(out))
}

/// Engine entry: `{records, project_id, generated_at}` → the consensus report.
///
/// # Errors
/// `InvalidInput` when `records` is not a `RecordsByModule` object or `project_id` /
/// `generated_at` are not strings.
pub fn run(request: &Map<String, Value>) -> Result<Value, EngineError> {
    let records = extended_records(&records_field(request))?;
    let project_id = str_field(request, "project_id")?;
    let generated_at = str_field(request, "generated_at")?;
    automated_consensus(&records, project_id, generated_at)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request(value: &Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    fn code(value: &Value) -> Option<&'static str> {
        run(&request(value)).err().map(|e| e.code())
    }

    #[test]
    fn rejects_shapes_the_typescript_types_reject() {
        let at = "2026-10-12T12:00:00Z";
        for bad in [
            json!({"records": [], "project_id": "P", "generated_at": at}),
            json!({"records": "x", "project_id": "P", "generated_at": at}),
            json!({"records": {"Intereses": {}}, "project_id": "P", "generated_at": at}),
            json!({"records": {"Dialogos": [{"id": 1, "payload": {}}]}, "project_id": "P", "generated_at": at}),
            json!({"records": {"Hechos_Compartidos": [{"id": "h", "payload": []}]}, "project_id": "P", "generated_at": at}),
            json!({"records": {"Evaluaciones_AARC": [{"id": "a"}]}, "project_id": "P", "generated_at": at}),
            json!({"records": {}, "generated_at": at}),
            json!({"records": {}, "project_id": 7, "generated_at": at}),
            json!({"records": {}, "project_id": "P"}),
            json!({"records": {}, "project_id": "P", "generated_at": null}),
        ] {
            assert_eq!(code(&bad), Some("invalid_input"), "{bad}");
        }
    }

    #[test]
    fn ignores_modules_outside_the_extended_layer() {
        let ok = run(&request(&json!({
            "records": {"Eventos": "not checked", "Hechos": 1},
            "project_id": "P",
            "generated_at": "t",
        })));
        assert!(ok.is_ok());
    }
}
