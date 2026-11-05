//! The records rules review approvals go through: `contexts/records/domain/{modules,import}.ts`
//! and `RecordsService.createMissing`, for string fields (the only kind review records carry).

use sipges_tools_common::js;

/// `MAX_IMPORT_ROWS`.
pub const MAX_IMPORT_ROWS: usize = 2000;
/// `MAX_IMPORT_VALUE` (UTF-16 units).
pub const MAX_IMPORT_VALUE: usize = 10_000;
/// `MAX_RECORD_ID` (UTF-16 units).
pub const MAX_RECORD_ID: usize = 200;

/// Ordered string fields, as a JavaScript object with insertion order.
pub type Fields = Vec<(String, String)>;

/// URL slug → stored module name (`MODULES`).
const MODULES: &[(&str, &str)] = &[
    ("eventos", "Eventos"),
    ("actores", "Actores"),
    ("demandas", "Demandas"),
    ("compromisos", "Compromisos"),
    ("narrativas", "Narrativas"),
    ("fuentes", "Fuentes"),
    ("indicadores", "Indicadores"),
    ("alertas", "Alertas"),
    ("acciones", "Acciones"),
    ("directorio", "Directorio_Territorial"),
    ("priorizados", "Actores_Priorizados"),
    ("usuarios", "Usuarios"),
    ("roles", "Roles"),
    ("proyectos", "Proyectos"),
    ("intereses", "Intereses"),
    ("dialogos", "Dialogos"),
    ("oportunidades", "Oportunidades"),
    ("hechos", "Hechos_Compartidos"),
    ("aarc", "Evaluaciones_AARC"),
    ("buzon", "Buzon"),
    ("lecciones", "Lecciones_Territoriales"),
];

/// `ID_KEYS`: the payload field that carries the record id.
const ID_KEYS: &[(&str, &str)] = &[
    ("Eventos", "ID_Evento"),
    ("Actores", "ID_Actor"),
    ("Demandas", "ID_Demanda"),
    ("Compromisos", "ID_Compromiso"),
    ("Narrativas", "ID_Narrativa"),
    ("Fuentes", "ID_Fuente"),
    ("Indicadores", "Codigo"),
    ("Alertas", "ID_Alerta"),
    ("Acciones", "ID_Accion"),
    ("Usuarios", "ID_Usuario"),
    ("Roles", "ID_Rol"),
    ("Proyectos", "Proyecto_ID"),
    ("Buzon", "ID_Caso"),
    ("Lecciones_Territoriales", "ID_Leccion"),
];

/// `PREFIXES` of generated ids.
const PREFIXES: &[(&str, &str)] = &[
    ("Eventos", "EV"),
    ("Actores", "A"),
    ("Demandas", "D"),
    ("Alertas", "AL"),
    ("Fuentes", "F"),
    ("Usuarios", "USR"),
    ("Roles", "ROL"),
    ("Proyectos", "PRJ"),
    ("Buzon", "BZ"),
    ("Lecciones_Territoriales", "LEC"),
];

fn lookup(table: &'static [(&'static str, &'static str)], key: &str) -> Option<&'static str> {
    table.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

/// `moduleForSlug` (own properties only).
#[must_use]
pub fn module_for_slug(slug: &str) -> Option<&'static str> {
    lookup(MODULES, slug)
}

/// `isLookupableId`.
#[must_use]
pub fn is_lookupable_id(id: &str) -> bool {
    js::utf16_len(id) <= MAX_RECORD_ID && !id.contains('\0')
}

fn field<'a>(fields: &'a Fields, key: &str) -> Option<&'a str> {
    fields
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}

/// `validatePayload` for string values: the id field must be at most 200 UTF-16 units.
#[must_use]
pub fn validate_payload(module: &str, fields: &Fields) -> Option<(String, String)> {
    let key = lookup(ID_KEYS, module)?;
    let value = field(fields, key)?;
    if value.is_empty() || js::utf16_len(value) <= MAX_RECORD_ID {
        return None;
    }
    Some((
        key.to_owned(),
        format!("{key} must be a string or number of at most {MAX_RECORD_ID} characters"),
    ))
}

/// `recordIdFor`: the id field when non-empty, else `<prefix>-<8 hex>`.
pub fn record_id_for(
    module: &str,
    fields: &Fields,
    random_hex: &mut dyn FnMut(usize) -> String,
) -> String {
    if let Some(value) = lookup(ID_KEYS, module)
        .and_then(|key| field(fields, key))
        .filter(|value| !value.is_empty())
    {
        return value.to_owned();
    }
    let prefix = lookup(PREFIXES, module).map_or_else(
        // module.slice(0, 3).toUpperCase(): module names are ASCII.
        || module.chars().take(3).collect::<String>().to_uppercase(),
        str::to_owned,
    );
    format!("{prefix}-{}", random_hex(8))
}

/// `ImportProblem`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Problem {
    /// Row number from 1.
    pub row: usize,
    /// Spanish message.
    pub message: String,
}

/// A planned row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlannedItem {
    /// Row number from 1.
    pub row: usize,
    /// The id rule's id.
    pub id: String,
    /// Trimmed, non-blank fields.
    pub payload: Fields,
}

/// `planImport` without a project (as `createMissing` calls it).
pub fn plan_import(
    module: &str,
    rows: &[Fields],
    random_hex: &mut dyn FnMut(usize) -> String,
) -> (Vec<PlannedItem>, Vec<Problem>) {
    let mut items = Vec::new();
    let mut problems = Vec::new();
    let mut seen: Vec<(String, usize)> = Vec::new();
    for (index, raw) in rows.iter().enumerate() {
        let row = index + 1;
        let mut payload: Fields = Vec::new();
        for (key, value) in raw {
            let text = js::trim(value);
            let name = js::trim(key);
            if name.is_empty() || text.is_empty() {
                continue;
            }
            // payload[field.trim()] = text: a repeated trimmed key keeps its first position.
            if let Some(slot) = payload.iter_mut().find(|(k, _)| k == name) {
                text.clone_into(&mut slot.1);
            } else {
                payload.push((name.to_owned(), text.to_owned()));
            }
        }
        if payload.is_empty() {
            continue;
        }
        if payload
            .iter()
            .any(|(k, v)| k.contains('\0') || v.contains('\0'))
        {
            problems.push(Problem {
                row,
                message: "Contiene caracteres NUL".into(),
            });
            continue;
        }
        if payload
            .iter()
            .any(|(_, v)| js::utf16_len(v) > MAX_IMPORT_VALUE)
        {
            problems.push(Problem {
                row,
                message: format!("Un valor supera {MAX_IMPORT_VALUE} caracteres"),
            });
            continue;
        }
        if let Some((field, message)) = validate_payload(module, &payload) {
            problems.push(Problem {
                row,
                message: format!("{field}: {message}"),
            });
            continue;
        }
        let id = record_id_for(module, &payload, random_hex);
        if let Some((_, previous)) = seen.iter().find(|(known, _)| *known == id) {
            problems.push(Problem {
                row,
                message: format!("El código {id} ya aparece en la fila {previous}"),
            });
            continue;
        }
        seen.push((id.clone(), row));
        items.push(PlannedItem { row, id, payload });
    }
    (items, problems)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields(pairs: &[(&str, &str)]) -> Fields {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn plans_like_typescript() {
        let mut counter = 0_u32;
        let mut hex = |len: usize| {
            let value = format!("{counter:0len$x}");
            counter += 1;
            value
        };
        let rows = vec![
            fields(&[
                ("ID_Actor", " A-1 "),
                (" Nombre ", "x"),
                ("Vacio", " \u{FEFF}"),
            ]),
            fields(&[("  ", "y")]),
            fields(&[("ID_Actor", "A-1")]),
            fields(&[("ID_Actor", &"x".repeat(201))]),
            fields(&[("Nota", "a\0")]),
            fields(&[("Nota", &"é".repeat(10_001))]),
            fields(&[("Nota", "sin id")]),
        ];
        let (items, problems) = plan_import("Actores", &rows, &mut hex);
        assert_eq!(items.len(), 2);
        assert_eq!(items.first().map(|i| i.id.as_str()), Some("A-1"));
        assert_eq!(
            items.first().map(|i| i.payload.clone()),
            Some(fields(&[("ID_Actor", "A-1"), ("Nombre", "x")]))
        );
        assert_eq!(items.get(1).map(|i| i.id.as_str()), Some("A-00000000"));
        let messages: Vec<_> = problems
            .iter()
            .map(|p| (p.row, p.message.as_str()))
            .collect();
        assert_eq!(
            messages,
            vec![
                (3, "El código A-1 ya aparece en la fila 1"),
                (
                    4,
                    "ID_Actor: ID_Actor must be a string or number of at most 200 characters"
                ),
                (5, "Contiene caracteres NUL"),
                (6, "Un valor supera 10000 caracteres"),
            ]
        );
    }

    #[test]
    fn prefixes_modules_without_one() {
        let mut hex = |len: usize| "0".repeat(len);
        assert_eq!(
            record_id_for("Hechos_Compartidos", &Vec::new(), &mut hex),
            "HEC-00000000"
        );
        assert_eq!(
            record_id_for("Dialogos", &Vec::new(), &mut hex),
            "DIA-00000000"
        );
        assert_eq!(module_for_slug("hechos"), Some("Hechos_Compartidos"));
        assert_eq!(module_for_slug("toString"), None);
    }
}
