//! Approved review findings as records: `contexts/documents/domain/review-records.ts`.

use std::time::SystemTime;

use sipges_tools_common::time;

use crate::records::Fields;

/// `APPROVAL_STATUSES`.
pub const APPROVAL_STATUSES: [&str; 2] = ["aceptado_para_revision", "corroborado_documentalmente"];

/// `REVIEW_SOURCE`.
pub const REVIEW_SOURCE: &str = "la bandeja de revisión documental";

/// A `document_review` row.
#[derive(Clone, Debug)]
pub struct ReviewItem {
    /// Item id.
    pub id: String,
    /// Source file name.
    pub source_file: String,
    /// Source SHA-256.
    pub source_sha256: String,
    /// Location in the source.
    pub location: String,
    /// Lexical theme.
    pub theme: String,
    /// Excerpt.
    pub excerpt: String,
    /// Suggested action.
    pub action: String,
    /// Review status.
    pub status: String,
    /// Reviewer.
    pub reviewer: String,
    /// Review note.
    pub note: String,
    /// Last decision time (millisecond `Date`).
    pub updated_at: SystemTime,
}

/// `reviewTarget(theme).module`: the records slug a theme goes to.
#[must_use]
pub fn review_target(theme: &str) -> &'static str {
    match theme {
        "Actor (extracción automática)" | "Representatividad y gobernanza" => "actores",
        "Demandas e intereses" => "demandas",
        "Compromisos y trazabilidad" => "compromisos",
        "Diálogo y construcción de consensos" => "dialogos",
        "Oportunidades de valor compartido" => "oportunidades",
        "Territorio y ambiente" => "narrativas",
        _ => "hechos",
    }
}

/// `projectOf`: after the first `/` (the whole id when there is none).
#[must_use]
pub fn project_of(tenant_id: &str) -> &str {
    tenant_id
        .split_once('/')
        .map_or(tenant_id, |(_, project)| project)
}

/// `reviewRecordId`.
#[must_use]
pub fn review_record_id(item_id: &str) -> String {
    format!("REV-{item_id}")
}

fn status_label(status: &str) -> &str {
    match status {
        "aceptado_para_revision" => "aceptado para revisión",
        "corroborado_documentalmente" => "corroborado documentalmente",
        // pendiente and descartado print as stored; the column's check allows nothing else.
        other => other,
    }
}

/// A `Date` JavaScript cannot represent makes `toISOString` throw `RangeError`.
#[derive(Debug)]
pub struct InvalidDate;

impl std::fmt::Display for InvalidDate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Invalid time value")
    }
}

impl std::error::Error for InvalidDate {}

fn push(fields: &mut Fields, key: &str, value: &str) {
    if let Some(slot) = fields.iter_mut().find(|(k, _)| k == key) {
        value.clone_into(&mut slot.1);
    } else {
        fields.push((key.to_owned(), value.to_owned()));
    }
}

/// The fields of the target module (the `switch` of `reviewRecordFields`).
fn own_fields(item: &ReviewItem, id: String, date: String) -> Vec<(&'static str, String)> {
    let corroborated = item.status == "corroborado_documentalmente";
    let excerpt = item.excerpt.as_str();
    let theme = item.theme.as_str();
    match review_target(&item.theme) {
        "actores" => vec![
            ("ID_Actor", id),
            (
                "Nombre_Actor/Organizacion",
                format!("Por identificar ({})", item.source_file),
            ),
            ("Tipo_Actor", "Otro / por verificar".into()),
            ("Rol/Relacion", excerpt.into()),
        ],
        "demandas" => vec![
            ("ID_Demanda", id),
            ("Fecha_Registro", date),
            ("Tema", theme.into()),
            ("Descripcion", excerpt.into()),
            ("Estado", "En revisión".into()),
        ],
        "compromisos" => vec![
            ("ID_Compromiso", id),
            ("Fecha", date),
            ("Descripcion", excerpt.into()),
            ("Estado", "Pendiente".into()),
        ],
        "dialogos" => vec![
            ("Proceso", excerpt.into()),
            ("Tema", theme.into()),
            ("Estado", "Por verificar".into()),
        ],
        "oportunidades" => vec![
            ("Oportunidad", excerpt.into()),
            ("Estado", "En evaluación".into()),
        ],
        "narrativas" => vec![
            ("ID_Narrativa", id),
            ("Fecha_Observacion", date),
            ("Plataforma/Fuente", item.source_file.clone()),
            ("Tema", theme.into()),
            ("Categoria", "E - Ambiental-territorial".into()),
            ("Descripcion", excerpt.into()),
            ("Tono", "Por evaluar".into()),
            (
                "Nivel_Verificacion",
                if corroborated {
                    "B - Corroborada"
                } else {
                    "E - No verificada"
                }
                .into(),
            ),
        ],
        _ => vec![
            ("Asunto", excerpt.into()),
            ("Accion_Verificacion", item.action.clone()),
            (
                "Estado",
                if corroborated {
                    "validado"
                } else {
                    "pendiente"
                }
                .into(),
            ),
        ],
    }
}

/// `reviewRecordFields`: `{ ...own, ...common, Observaciones }`.
///
/// # Errors
/// `updated_at` outside JavaScript's `Date` range.
pub fn review_record_fields(item: &ReviewItem, project_id: &str) -> Result<Fields, InvalidDate> {
    let id = review_record_id(&item.id);
    let iso = time::to_iso_string(item.updated_at).ok_or(InvalidDate)?;
    let date: String = iso.chars().take(10).collect();
    let reviewer = if item.reviewer.is_empty() {
        String::new()
    } else {
        format!(" por {}", item.reviewer)
    };
    let notes = [
        format!(
            "Hallazgo documental {}{reviewer}.",
            status_label(&item.status)
        ),
        if item.theme.is_empty() {
            String::new()
        } else {
            format!("Tema: {}.", item.theme)
        },
        if item.action.is_empty() {
            String::new()
        } else {
            format!("Acción sugerida: {}", item.action)
        },
        if item.note.is_empty() {
            String::new()
        } else {
            format!("Nota de revisión: {}", item.note)
        },
        format!(
            "Documento: {} (SHA-256 {}), {}.",
            item.source_file, item.source_sha256, item.location
        ),
    ];
    let own = own_fields(item, id, date);
    let mut fields: Fields = Vec::new();
    for (key, value) in &own {
        push(&mut fields, key, value);
    }
    push(&mut fields, "Proyecto_ID", project_id);
    push(
        &mut fields,
        "Fuente_ID",
        &format!("{} · {}", item.source_file, item.location),
    );
    push(&mut fields, "Revision_Documental_ID", &item.id);
    let joined: Vec<&str> = notes
        .iter()
        .map(String::as_str)
        .filter(|n| !n.is_empty())
        .collect();
    push(&mut fields, "Observaciones", &joined.join(" "));
    Ok(fields)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, UNIX_EPOCH};

    fn item(theme: &str, status: &str) -> ReviewItem {
        ReviewItem {
            id: "RV-1".into(),
            source_file: "informe.pdf".into(),
            source_sha256: "a".repeat(64),
            location: "p. 3".into(),
            theme: theme.into(),
            excerpt: "Texto".into(),
            action: String::new(),
            status: status.into(),
            reviewer: "ana".into(),
            note: String::new(),
            updated_at: UNIX_EPOCH + Duration::from_millis(1_793_836_799_999),
        }
    }

    #[test]
    fn builds_the_same_fields() {
        let fields = review_record_fields(
            &item("Demandas e intereses", "aceptado_para_revision"),
            "PRJ",
        )
        .unwrap_or_default();
        let keys: Vec<&str> = fields.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(
            keys,
            [
                "ID_Demanda",
                "Fecha_Registro",
                "Tema",
                "Descripcion",
                "Estado",
                "Proyecto_ID",
                "Fuente_ID",
                "Revision_Documental_ID",
                "Observaciones"
            ]
        );
        assert_eq!(fields.get(1).map(|(_, v)| v.as_str()), Some("2026-11-04"));
        assert_eq!(
            fields.last().map(|(_, v)| v.as_str()),
            Some(
                "Hallazgo documental aceptado para revisión por ana. Tema: Demandas e intereses. Documento: informe.pdf (SHA-256 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa), p. 3."
            )
        );
        let other = review_record_fields(&item("libre", "corroborado_documentalmente"), "PRJ")
            .unwrap_or_default();
        assert_eq!(other.get(2).map(|(_, v)| v.as_str()), Some("validado"));
        assert_eq!(project_of("C/P/Q"), "P/Q");
        assert_eq!(project_of("sin"), "sin");
    }
}
