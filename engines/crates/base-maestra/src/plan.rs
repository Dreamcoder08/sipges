//! `plan.ts`: module checks, record ids and problems, in JavaScript's enumeration order.

use std::fmt::Write as _;

use sipges_indicators::js::number_to_string;
use sipges_tools_common::js::utf16_len;

use crate::json::{self, Json};

/// A row's fields.
pub type Object = Vec<(String, Json)>;

fn get<'a>(object: &'a Object, key: &str) -> Option<&'a Json> {
    object.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

/// Stored module names (`RECORD_MODULES`).
const MODULES: [&str; 21] = [
    "Eventos",
    "Actores",
    "Demandas",
    "Compromisos",
    "Narrativas",
    "Fuentes",
    "Indicadores",
    "Alertas",
    "Acciones",
    "Directorio_Territorial",
    "Actores_Priorizados",
    "Usuarios",
    "Roles",
    "Proyectos",
    "Intereses",
    "Dialogos",
    "Oportunidades",
    "Hechos_Compartidos",
    "Evaluaciones_AARC",
    "Buzon",
    "Lecciones_Territoriales",
];

/// `NOT_IMPORTABLE`.
const NOT_IMPORTABLE: [&str; 3] = ["Usuarios", "Roles", "Proyectos"];

/// `ID_KEYS` of `records/domain/modules.ts` (what `validatePayload` checks).
const ID_KEYS: [(&str, &str); 14] = [
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

/// `ID_FIELDS` of `plan.ts` (the id fields the import keeps).
const ID_FIELDS: [(&str, &str); 9] = [
    ("Eventos", "ID_Evento"),
    ("Actores", "ID_Actor"),
    ("Demandas", "ID_Demanda"),
    ("Compromisos", "ID_Compromiso"),
    ("Narrativas", "ID_Narrativa"),
    ("Fuentes", "ID_Fuente"),
    ("Indicadores", "Codigo"),
    ("Alertas", "ID_Alerta"),
    ("Acciones", "ID_Accion"),
];

/// `PREFIXES` of `plan.ts`.
const PREFIXES: [(&str, &str); 5] = [
    ("Eventos", "EV"),
    ("Actores", "A"),
    ("Demandas", "D"),
    ("Alertas", "AL"),
    ("Fuentes", "F"),
];

fn lookup(table: &[(&'static str, &'static str)], key: &str) -> Option<&'static str> {
    table.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

/// `String(value)` of a JSON scalar.
fn js_string(value: &Json) -> String {
    match value {
        Json::Str(s) => s.clone(),
        Json::Num(x) if x.is_nan() => "NaN".into(),
        Json::Num(x) if x.is_infinite() => if *x > 0.0 { "Infinity" } else { "-Infinity" }.into(),
        Json::Num(x) => number_to_string(*x),
        other => json::stringify(other),
    }
}

/// `value !== undefined && value !== null && value !== '' && value !== 0`.
fn present(value: Option<&Json>) -> Option<&Json> {
    value.filter(|v| match v {
        Json::Null => false,
        Json::Str(s) => !s.is_empty(),
        Json::Num(x) => *x != 0.0,
        _ => true,
    })
}

/// `hasNul` of the records contract (keys and strings, recursively).
/// `RecordIn.safeParse({ payload })`: Zod 4's `z.record` leaves a top-level `__proto__` key out
/// of its output, so `hasNul` never sees that key or its value; nested objects are checked whole.
fn row_has_nul(row: &Object) -> bool {
    row.iter()
        .filter(|(k, _)| k != "__proto__")
        .any(|(k, v)| k.contains('\0') || has_nul(v))
}

/// Nesting depth (arrays and objects), without recursion.
fn depth(value: &Json) -> usize {
    let mut deepest = 0;
    let mut stack = vec![(value, 1_usize)];
    while let Some((value, level)) = stack.pop() {
        let children: &mut dyn Iterator<Item = &Json> = match value {
            Json::Arr(items) => &mut items.iter(),
            Json::Obj(object) => &mut object.iter().map(|(_, v)| v),
            _ => continue,
        };
        deepest = deepest.max(level);
        stack.extend(children.map(|child| (child, level + 1)));
    }
    deepest
}

/// Deepest row the Rust tool plans. TypeScript's recursive `hasNul` and `canonical` overflow
/// Node's stack (`RangeError`, nothing written) from about 2,500 levels, at a depth that varies
/// with the stack; refusing above 1,000 never writes a row TypeScript would refuse.
pub const MAX_ROW_DEPTH: usize = 1000;

/// A row nested beyond [`MAX_ROW_DEPTH`]: the run stops as TypeScript's `RangeError` does.
#[derive(Debug, PartialEq, Eq)]
pub struct TooDeep;

fn has_nul(value: &Json) -> bool {
    match value {
        Json::Str(s) => s.contains('\0'),
        Json::Arr(items) => items.iter().any(has_nul),
        Json::Obj(object) => object.iter().any(|(k, v)| k.contains('\0') || has_nul(v)),
        _ => false,
    }
}

/// `validatePayload` fails: the id field is neither a string nor a finite number of at most
/// 200 UTF-16 units (absent, `null` and `''` pass).
fn invalid_id(module: &str, payload: &Object) -> Option<&'static str> {
    let key = lookup(&ID_KEYS, module)?;
    let value = get(payload, key)?;
    let scalar = match value {
        Json::Null => return None,
        Json::Str(s) if s.is_empty() => return None,
        Json::Str(_) => true,
        Json::Num(x) => x.is_finite(),
        _ => false,
    };
    if scalar && utf16_len(&js_string(value)) <= 200 {
        None
    } else {
        Some(key)
    }
}

/// `withTenantProject` of `records/domain/modules.ts` refuses the row: `Proyecto_ID` is neither
/// empty (absent, `null`, `''`) nor exactly the target project. `0`, `false` and objects are refused.
fn foreign_project(payload: &Object, project: &str) -> bool {
    match get(payload, "Proyecto_ID") {
        None | Some(Json::Null) => false,
        Some(Json::Str(s)) => !s.is_empty() && s != project,
        Some(_) => true,
    }
}

/// UTF-16 code unit order, as `Array.prototype.sort` compares strings.
fn utf16_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `canonical`: sorted keys at every level, JavaScript spelling.
#[must_use]
pub fn canonical(value: &Json) -> String {
    let mut out = String::new();
    write_canonical(&mut out, value);
    out
}

fn write_canonical(out: &mut String, value: &Json) {
    match value {
        Json::Arr(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(out, item);
            }
            out.push(']');
        }
        Json::Obj(object) => {
            let mut sorted: Vec<&(String, Json)> = object.iter().collect();
            sorted.sort_by(|a, b| utf16_cmp(&a.0, &b.0));
            out.push('{');
            for (i, (key, item)) in sorted.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                json::write_string(out, key);
                out.push(':');
                write_canonical(out, item);
            }
            out.push('}');
        }
        other => json::write_json(out, other),
    }
}

/// `baseMaestraId`.
#[must_use]
pub fn base_maestra_id(module: &str, payload: &Object) -> String {
    if let Some(value) = present(lookup(&ID_FIELDS, module).and_then(|key| get(payload, key))) {
        return js_string(value);
    }
    let prefix = lookup(&PREFIXES, module).map_or_else(
        || module.chars().take(3).collect::<String>().to_uppercase(),
        str::to_owned,
    );
    let text = format!("{module}\n{}", canonical(&Json::Obj(payload.clone())));
    let digest = ring::digest::digest(&ring::digest::SHA256, text.as_bytes());
    let mut hex = String::new();
    for byte in digest.as_ref().iter().take(4) {
        let _ = write!(hex, "{byte:02X}");
    }
    format!("{prefix}-{hex}")
}

/// One module of the plan.
#[derive(Debug)]
pub struct PlannedModule {
    /// Stored module name.
    pub module: &'static str,
    /// Rows in the file.
    pub in_file: usize,
    /// Valid rows with their ids, in file order.
    pub items: Vec<(String, Object)>,
}

/// `BaseMaestraPlan`.
#[derive(Debug, Default)]
pub struct Plan {
    /// Importable modules in file order.
    pub modules: Vec<PlannedModule>,
    /// Codes and positions only.
    pub problems: Vec<String>,
}

/// `planBaseMaestra`. `project` is the project of the target tenant: a row naming another one is
/// a problem. Only the check is shared with the records import: rows are stored as written, so a
/// missing `Proyecto_ID` stays missing and the row keeps its content-derived id.
/// # Errors
/// A row of an importable module nested beyond [`MAX_ROW_DEPTH`].
pub fn plan(seed: &Json, project: &str) -> Result<Plan, TooDeep> {
    let Json::Obj(seed) = seed else {
        return Ok(Plan {
            modules: Vec::new(),
            problems: vec!["El archivo no es un objeto {Módulo: [registros]}".into()],
        });
    };
    let mut out = Plan::default();
    for (name, rows) in json::entries(seed) {
        let Some(module) = MODULES.iter().copied().find(|m| m == name) else {
            out.problems
                .push("Módulo desconocido (clave omitida por privacidad)".into());
            continue;
        };
        if NOT_IMPORTABLE.contains(&module) {
            continue;
        }
        let Json::Arr(rows) = rows else {
            out.problems.push(format!("{name}: se esperaba una lista"));
            continue;
        };
        let mut items: Vec<(String, Object)> = Vec::new();
        let mut known_ids: std::collections::HashMap<String, usize> =
            std::collections::HashMap::new();
        for (index, row) in rows.iter().enumerate() {
            let position = format!("{name}[{index}]");
            let Json::Obj(payload) = row else {
                out.problems.push(format!("{position}: no es un objeto"));
                continue;
            };
            if depth(row) > MAX_ROW_DEPTH {
                return Err(TooDeep);
            }
            if row_has_nul(payload) {
                out.problems
                    .push(format!("{position}: contiene caracteres NUL"));
                continue;
            }
            if let Some(field) = invalid_id(module, payload) {
                out.problems
                    .push(format!("{position}: {field} no es un código válido"));
                continue;
            }
            if foreign_project(payload, project) {
                out.problems.push(format!(
                    "{position}: Proyecto_ID no corresponde al proyecto activo"
                ));
                continue;
            }
            let id = base_maestra_id(module, payload);
            if let Some(previous) = known_ids.get(&id) {
                out.problems.push(format!(
                    "{position}: código duplicado de {name}[{previous}]"
                ));
                continue;
            }
            known_ids.insert(id.clone(), index);
            items.push((id, payload.clone()));
        }
        out.modules.push(PlannedModule {
            module,
            in_file: rows.len(),
            items,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Json {
        json::parse(text).unwrap_or(Json::Null)
    }

    #[test]
    fn hashes_like_typescript() {
        // Values from Node: baseMaestraId(module, payload) of plan.ts.
        let payload = parse(r#"{"b":1,"a":[true,null,"x"],"ñ":{"z":1.5e-7,"y":1e21}}"#);
        let Json::Obj(map) = payload else { return };
        assert_eq!(
            canonical(&Json::Obj(map.clone())),
            r#"{"a":[true,null,"x"],"b":1,"ñ":{"y":1e+21,"z":1.5e-7}}"#
        );
        assert_eq!(base_maestra_id("Intereses", &map), "INT-FBE28A8C");
        let keyed = parse(r#"{"ID_Evento":12.50}"#);
        let Json::Obj(keyed) = keyed else { return };
        assert_eq!(base_maestra_id("Eventos", &keyed), "12.5");
    }

    #[test]
    fn mirrors_zod_and_stack_limits() {
        // Zod drops a top-level __proto__ key before hasNul; nested ones are still checked.
        let seed =
            parse(r#"{"Eventos":[{"__proto__":"a\u0000b"},{"x":{"__proto__":"a\u0000b"}}]}"#);
        assert_eq!(
            plan(&seed, "PRJ-T").map(|p| p.problems),
            Ok(vec!["Eventos[1]: contiene caracteres NUL".to_owned()])
        );
        let deep = format!(
            r#"{{"Intereses":[{{"x":{}1{}}}]}}"#,
            "[".repeat(1000),
            "]".repeat(1000)
        );
        assert_eq!(plan(&parse(&deep), "PRJ-T").err(), Some(TooDeep));
        let ok = format!(
            r#"{{"Intereses":[{{"x":{}1{}}}]}}"#,
            "[".repeat(998),
            "]".repeat(998)
        );
        assert!(plan(&parse(&ok), "PRJ-T").is_ok());
        // Unknown modules are never walked (parsing this deep needs the binary's large stack).
        let walked = std::thread::Builder::new()
            .stack_size(64 * 1024 * 1024)
            .spawn(|| {
                let unknown = format!(r#"{{"Otro":[{}]}}"#, "[".repeat(5000) + &"]".repeat(5000));
                plan(&parse(&unknown), "PRJ-T").is_ok()
            })
            .ok()
            .and_then(|handle| handle.join().ok());
        assert_eq!(walked, Some(true));
    }

    #[test]
    fn reports_problems_in_javascript_order() {
        let seed = parse(
            r#"{"Eventos":[{"ID_Evento":"E1"},{"ID_Evento":"E1"},[],{"ID_Evento":true},{"x":"a\u0000"}],"7":[],"Usuarios":5,"Actores":{}}"#,
        );
        let plan = plan(&seed, "PRJ-T").unwrap_or_default();
        assert_eq!(
            plan.problems,
            [
                "Módulo desconocido (clave omitida por privacidad)",
                "Eventos[1]: código duplicado de Eventos[0]",
                "Eventos[2]: no es un objeto",
                "Eventos[3]: ID_Evento no es un código válido",
                "Eventos[4]: contiene caracteres NUL",
                "Actores: se esperaba una lista",
            ]
        );
        assert_eq!(plan.modules.len(), 1);
    }

    #[test]
    fn refuses_a_row_of_another_project_without_echoing_it() {
        for value in [
            r#""PRJ-OTRO""#,
            r#"" ""#,
            r#""prj-t""#,
            "0",
            "-0",
            "5",
            "false",
            "true",
            "{}",
            "[]",
        ] {
            let seed = parse(&format!(
                r#"{{"Eventos":[{{"ID_Evento":"E1"}},{{"ID_Evento":"E2","Proyecto_ID":{value}}}]}}"#
            ));
            let plan = plan(&seed, "PRJ-T").unwrap_or_default();
            assert_eq!(
                plan.problems,
                ["Eventos[1]: Proyecto_ID no corresponde al proyecto activo"],
                "{value}"
            );
            let kept: Vec<usize> = plan.modules.iter().map(|m| m.items.len()).collect();
            assert_eq!(kept, [1], "{value}");
        }
    }

    #[test]
    fn keeps_a_row_with_an_empty_missing_or_matching_project() {
        let seed = parse(
            r#"{"Eventos":[{"ID_Evento":"E1"},{"ID_Evento":"E2","Proyecto_ID":null},{"ID_Evento":"E3","Proyecto_ID":""},{"ID_Evento":"E4","Proyecto_ID":"PRJ-T"}],"Proyectos":[{"Proyecto_ID":"PRJ-OTRO"}]}"#,
        );
        let plan = plan(&seed, "PRJ-T").unwrap_or_default();
        assert!(plan.problems.is_empty(), "{:?}", plan.problems);
        let items: Vec<&(String, Object)> = plan.modules.iter().flat_map(|m| &m.items).collect();
        assert_eq!(items.len(), 4);
        // Stored as written: the import never fills the field in.
        assert!(
            items
                .first()
                .is_some_and(|(_, row)| get(row, "Proyecto_ID").is_none())
        );
    }
}
