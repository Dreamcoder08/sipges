//! Situational analysis engine: port of `buildSituational`
//! (`apps/api/src/contexts/analytics/domain/situational.ts`, app.py:627 `build_situational`).
//! A deterministic synthesis of the master base, not a validated judgment. Every record of the
//! tenant counts: the tenant is the project, so its `Proyecto_ID` field is not re-checked.
//!
//! [`run`] takes `{records, project_id, generated_at, tenant_label?}` and returns the value whose
//! `js::stringify` equals `JSON.stringify(buildSituational(...))` byte for byte.

use serde_json::{Map, Value};
pub use sipges_analytics_common::EngineError;
use sipges_analytics_common::{
    DEFAULT_PROJECT_ID, Record, SITUATIONAL_MODULES, js, module_records, most_common, py_get,
    py_str, py_truthy, records_field, str_field,
};

/// `CLOSED`: states that close an alert or a demand.
const CLOSED: [&str; 6] = [
    "cerrada",
    "cerrado",
    "descartado",
    "descartada",
    "resuelta",
    "resuelto",
];

/// `ALERT_RANK`: priority of a preliminary alert level; unknown levels rank 4.
const ALERT_RANK: [(&str, u8); 4] = [("rojo", 0), ("naranja", 1), ("amarillo", 2), ("verde", 3)];

/// `SCENARIOS` (nombre, supuesto).
const SCENARIOS: [(&str, &str); 3] = [
    (
        "Favorable",
        "Se atienden y verifican oportunamente las demandas y alertas pendientes.",
    ),
    (
        "Intermedio",
        "Persisten demandas y señales sin escalamiento confirmado.",
    ),
    (
        "Crítico",
        "Convergen eventos corroborados, alertas graves y falta de respuesta oportuna.",
    ),
];

/// `LIMITATIONS`.
const LIMITATIONS: [&str; 4] = [
    "Los registros pueden estar desactualizados, incompletos o pendientes de verificación.",
    "Los escenarios son condicionales, no pronósticos.",
    "IRSA requiere validación de pesos y umbrales; no se interpreta aquí como medición científica definitiva.",
    "El reporte requiere revisión y aprobación de un analista antes de circularse como documento institucional.",
];

/// `trim` fields of `eventos_recientes`.
const EVENT_FIELDS: [&str; 5] = [
    "Fecha",
    "Territorio",
    "Descripcion_Hecho",
    "Nivel_Verificacion",
    "Fuente_ID",
];
/// `trim` fields of `alertas_prioritarias`.
const ALERT_FIELDS: [&str; 5] = [
    "Fecha",
    "Nivel_Preliminar",
    "Causa",
    "Accion_Sugerida",
    "Fuente_ID",
];
/// `trim` fields of `demandas_abiertas`.
const DEMAND_FIELDS: [&str; 5] = [
    "Fecha_Registro",
    "Tema",
    "Descripcion",
    "Estado",
    "Fuente_ID",
];
/// `trim` fields of `actores`.
const ACTOR_FIELDS: [&str; 4] = [
    "Nombre_Actor/Organizacion",
    "Posicion_Proyecto",
    "Influencia",
    "Fuente_Principal",
];

/// The alert level label: `Nivel_Preliminar` when truthy, else `Nivel`, else «Sin nivel».
fn alert_level(x: &Record) -> String {
    let preliminary = x.get("Nivel_Preliminar");
    let level = if py_truthy(preliminary) {
        preliminary
    } else {
        x.get("Nivel")
    };
    or_default(level, "Sin nivel")
}

const METHOD: &str =
    "Síntesis descriptiva basada en registros; no predicción ni evaluación pericial.";

/// `isOpen`: `pyStr(pyGet(x, 'Estado')).trim().toLowerCase()` is not a closed state.
fn is_open(record: &Record) -> bool {
    let state = js::trim(&py_str(Some(py_get(record, "Estado")))).to_lowercase();
    !CLOSED.contains(&state.as_str())
}

/// `orDefault(value, fallback)`: `pyStr(value)` when truthy, else the fallback.
fn or_default(value: Option<&Value>, fallback: &str) -> String {
    if py_truthy(value) {
        py_str(value)
    } else {
        fallback.to_owned()
    }
}

/// `rank`: `ALERT_RANK.get(pyStr(pyGet(x, 'Nivel_Preliminar')).toLowerCase()) ?? 4`.
fn rank(record: &Record) -> u8 {
    let level = py_str(Some(py_get(record, "Nivel_Preliminar"))).to_lowercase();
    ALERT_RANK
        .iter()
        .find(|(name, _)| *name == level)
        .map_or(4, |&(_, r)| r)
}

/// app.py `trim()`: the selected fields (default `""`) plus the record id, first 8 items.
fn trim<'a>(items: impl IntoIterator<Item = &'a Record>, fields: &[&str]) -> Value {
    Value::Array(
        items
            .into_iter()
            .take(8)
            .map(|x| {
                let mut out = Map::new();
                for &field in fields {
                    out.insert(field.to_owned(), py_get(x, field).clone());
                }
                out.insert("id".to_owned(), x.get("_id").cloned().unwrap_or_default());
                Value::Object(out)
            })
            .collect(),
    )
}

/// `mostCommon(...)` as JSON `[[value, count], ...]`.
fn common(values: &[String], limit: Option<usize>) -> Value {
    Value::Array(
        most_common(values, limit)
            .into_iter()
            .map(|(value, count)| Value::Array(vec![Value::String(value), Value::from(count)]))
            .collect(),
    )
}

/// `(byModule[module] ?? []).map(recordWithId)`: a `null` module is empty, like `??`.
fn records_of(by_module: &Value, module: &str) -> Result<Vec<Record>, EngineError> {
    if matches!(by_module.get(module), Some(Value::Null)) {
        return Ok(Vec::new());
    }
    module_records(by_module, module)
}

/// The observations and recommendations for the open alerts, open demands and narratives.
fn observations_and_recommendations(
    alerts: usize,
    demands: usize,
    narratives: usize,
) -> (Vec<String>, Vec<&'static str>) {
    let mut observations: Vec<String> = Vec::new();
    if alerts > 0 {
        observations.push(format!(
            "Constan {alerts} alertas con estado no cerrado; requieren verificación de vigencia, gravedad y responsable.",
        ));
    }
    if demands > 0 {
        observations.push(format!(
            "Se registran {demands} demandas no cerradas; revisar competencia y respuesta institucional.",
        ));
    }
    if narratives > 0 {
        observations.push(format!(
            "Existen {narratives} narrativas registradas; su contenido no constituye por sí mismo prueba de un hecho.",
        ));
    }
    if observations.is_empty() {
        observations.push(
            "No hay señales suficientes para emitir conclusiones sustantivas con esta base de datos."
                .to_owned(),
        );
    }

    let mut recommendations: Vec<&'static str> = Vec::new();
    if alerts > 0 {
        recommendations.push(
            "Revisar alertas abiertas, contrastar evidencias y asignar responsables y plazos.",
        );
    }
    if demands > 0 {
        recommendations.push(
            "Actualizar la trazabilidad de demandas, respuesta institucional y compromisos asociados.",
        );
    }
    if narratives > 0 {
        recommendations.push(
            "Contrastar narrativas con fuentes independientes antes de atribuir hechos o responsabilidades.",
        );
    }
    recommendations.push(
        "Validar el diagnóstico con el equipo territorial y registrar fecha, fuentes y analista responsable.",
    );
    recommendations
        .push("Aplicar seguimiento periódico y documentar cambios frente al corte anterior.");

    (observations, recommendations)
}

/// `project_name`: the project record's `Nombre` (any JSON value), else «Proyecto Sechura» for the
/// legacy project, else `tenantLabel || projectId`.
fn project_name(project: Option<&Record>, project_id: &str, tenant_label: Option<&str>) -> Value {
    match project.and_then(|p| p.get("Nombre")) {
        Some(name) => name.clone(),
        None if project_id == DEFAULT_PROJECT_ID => Value::from("Proyecto Sechura"),
        None => Value::from(match tenant_label {
            Some(label) if !label.is_empty() => label,
            _ => project_id,
        }),
    }
}

/// `SCENARIOS` as JSON objects.
fn scenarios() -> Value {
    Value::Array(
        SCENARIOS
            .iter()
            .map(|&(nombre, supuesto)| {
                let mut s = Map::new();
                s.insert("nombre".to_owned(), Value::from(nombre));
                s.insert("supuesto".to_owned(), Value::from(supuesto));
                Value::Object(s)
            })
            .collect(),
    )
}

/// `buildSituational(records, project_id, generated_at, tenant_label)` over a JSON request.
///
/// # Errors
/// `InvalidInput` when `project_id` or `generated_at` is not a string, `tenant_label` is neither a
/// string nor `null`, or `records` is not a `RecordsByModule` object.
pub fn run(request: &Map<String, Value>) -> Result<Value, EngineError> {
    let by_module = records_field(request);
    let project_id = str_field(request, "project_id")?;
    let generated_at = str_field(request, "generated_at")?;
    let tenant_label = match request.get("tenant_label") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.as_str()),
        Some(_) => return Err(EngineError::input("tenant_label must be a string or null")),
    };
    if !by_module.is_object() {
        return Err(EngineError::input(
            "records must be an object of module arrays",
        ));
    }

    let groups = SITUATIONAL_MODULES
        .iter()
        .map(|module| records_of(&by_module, module))
        .collect::<Result<Vec<_>, _>>()?;
    let group = |module: &str| -> &[Record] {
        SITUATIONAL_MODULES
            .iter()
            .position(|m| *m == module)
            .and_then(|i| groups.get(i))
            .map_or(&[], Vec::as_slice)
    };
    let project = records_of(&by_module, "Proyectos")?
        .into_iter()
        .find(|r| r.get("Proyecto_ID").and_then(Value::as_str) == Some(project_id));

    let ev = group("Eventos");
    let de = group("Demandas");
    let al = group("Alertas");
    let nar = group("Narrativas");
    let ac = group("Actores");
    let active_alerts: Vec<&Record> = al.iter().filter(|x| is_open(x)).collect();
    let open_demands: Vec<&Record> = de.iter().filter(|x| is_open(x)).collect();

    let (observations, recommendations) =
        observations_and_recommendations(active_alerts.len(), open_demands.len(), nar.len());

    let mut priority_alerts = active_alerts.clone();
    priority_alerts.sort_by_key(|x| rank(x)); // stable, like Array.prototype.sort

    let project_name = project_name(project.as_ref(), project_id, tenant_label);

    let mut counts = Map::new();
    for (module, records) in SITUATIONAL_MODULES.iter().zip(&groups) {
        counts.insert(module.to_lowercase(), Value::from(records.len()));
    }

    let territories: Vec<String> = ev
        .iter()
        .map(|x| or_default(x.get("Territorio"), "Sin precisar"))
        .collect();
    let themes: Vec<String> = open_demands
        .iter()
        .map(|x| or_default(x.get("Tema"), "Sin tema"))
        .collect();
    let levels: Vec<String> = active_alerts.iter().map(|x| alert_level(x)).collect();

    let mut out = Map::new();
    out.insert("project_id".to_owned(), Value::from(project_id));
    out.insert("project_name".to_owned(), project_name);
    out.insert("generated_at".to_owned(), Value::from(generated_at));
    out.insert("method".to_owned(), Value::from(METHOD));
    out.insert("counts".to_owned(), Value::Object(counts));
    out.insert(
        "alertas_activas".to_owned(),
        Value::from(active_alerts.len()),
    );
    out.insert(
        "demandas_pendientes".to_owned(),
        Value::from(open_demands.len()),
    );
    out.insert("territorios".to_owned(), common(&territories, Some(8)));
    out.insert("temas_demanda".to_owned(), common(&themes, Some(8)));
    out.insert("niveles_alerta".to_owned(), common(&levels, None));
    out.insert("eventos_recientes".to_owned(), trim(ev, &EVENT_FIELDS));
    out.insert(
        "alertas_prioritarias".to_owned(),
        trim(priority_alerts.iter().copied(), &ALERT_FIELDS),
    );
    out.insert(
        "demandas_abiertas".to_owned(),
        trim(open_demands.iter().copied(), &DEMAND_FIELDS),
    );
    out.insert("actores".to_owned(), trim(ac, &ACTOR_FIELDS));
    out.insert(
        "observaciones".to_owned(),
        Value::Array(observations.into_iter().map(Value::String).collect()),
    );
    out.insert("escenarios".to_owned(), scenarios());
    out.insert(
        "recomendaciones".to_owned(),
        Value::Array(recommendations.into_iter().map(Value::from).collect()),
    );
    out.insert(
        "limitations".to_owned(),
        Value::Array(LIMITATIONS.iter().map(|&l| Value::from(l)).collect()),
    );
    Ok(Value::Object(out))
}
