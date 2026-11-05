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
/// Outcome of `hasNul` over a row.
#[derive(Debug, PartialEq, Eq)]
enum Walk {
    Clean,
    Nul,
    TooDeep,
}

/// `hasNul` in JavaScript order (`Object.entries`, keys before their values), stopping at the
/// first NUL; containers past [`MAX_ROW_DEPTH`] stop it as Node's stack overflow would.
fn walk_value(value: &Json, level: usize) -> Walk {
    let walk_child = |child: &Json| match child {
        Json::Arr(_) | Json::Obj(_) if level + 1 > MAX_ROW_DEPTH => Walk::TooDeep,
        _ => walk_value(child, level + 1),
    };
    match value {
        Json::Str(s) if s.contains('\0') => Walk::Nul,
        Json::Arr(items) => items
            .iter()
            .map(walk_child)
            .find(|w| *w != Walk::Clean)
            .unwrap_or(Walk::Clean),
        Json::Obj(object) => json::entries(object)
            .into_iter()
            .map(|(k, v)| {
                if k.contains('\0') {
                    Walk::Nul
                } else {
                    walk_child(v)
                }
            })
            .find(|w| *w != Walk::Clean)
            .unwrap_or(Walk::Clean),
        _ => Walk::Clean,
    }
}

/// `RecordIn.safeParse({ payload })`: the row at level 1 without its top-level `__proto__` key,
/// which Zod 4's `z.record` leaves out of its output; nested objects are checked whole.
fn nul_walk(row: &Object) -> Walk {
    let kept: Object = row
        .iter()
        .filter(|(k, _)| k != "__proto__")
        .cloned()
        .collect();
    walk_value(&Json::Obj(kept), 1)
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

/// `planBaseMaestra`.
/// # Errors
/// A row of an importable module nested beyond [`MAX_ROW_DEPTH`].
pub fn plan(seed: &Json) -> Result<Plan, TooDeep> {
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
            // hasNul walks in JavaScript order and stops at the first NUL, so a NUL found before
            // the walk goes too deep is a problem, not a RangeError.
            match nul_walk(payload) {
                Walk::Nul => {
                    out.problems
                        .push(format!("{position}: contiene caracteres NUL"));
                    continue;
                }
                Walk::TooDeep => return Err(TooDeep),
                Walk::Clean => {}
            }
            if let Some(field) = invalid_id(module, payload) {
                out.problems
                    .push(format!("{position}: {field} no es un código válido"));
                continue;
            }
            // canonical() and JSON.stringify recurse over the whole row (a top-level __proto__
            // included); refuse every deep row here rather than risk writing one TypeScript cannot.
            if depth(row) > MAX_ROW_DEPTH {
                return Err(TooDeep);
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
    fn finds_a_nul_before_going_too_deep() {
        let deep = |n: usize| format!("{}1{}", "[".repeat(n), "]".repeat(n));
        let nul_first = format!(r#"{{"Eventos":[{{"a":"\u0000","x":{}}}]}}"#, deep(3000));
        let first = std::thread::Builder::new()
            .stack_size(64 * 1024 * 1024)
            .spawn(move || plan(&parse(&nul_first)).map(|p| p.problems))
            .ok()
            .and_then(|h| h.join().ok());
        assert_eq!(
            first,
            Some(Ok(vec!["Eventos[0]: contiene caracteres NUL".to_owned()]))
        );
        let deep_first = format!(r#"{{"Eventos":[{{"x":{},"a":"\u0000"}}]}}"#, deep(1000));
        assert_eq!(plan(&parse(&deep_first)).err(), Some(TooDeep));
    }

    #[test]
    fn mirrors_zod_and_stack_limits() {
        // Zod drops a top-level __proto__ key before hasNul; nested ones are still checked.
        let seed =
            parse(r#"{"Eventos":[{"__proto__":"a\u0000b"},{"x":{"__proto__":"a\u0000b"}}]}"#);
        assert_eq!(
            plan(&seed).map(|p| p.problems),
            Ok(vec!["Eventos[1]: contiene caracteres NUL".to_owned()])
        );
        let deep = format!(
            r#"{{"Intereses":[{{"x":{}1{}}}]}}"#,
            "[".repeat(1000),
            "]".repeat(1000)
        );
        assert_eq!(plan(&parse(&deep)).err(), Some(TooDeep));
        let ok = format!(
            r#"{{"Intereses":[{{"x":{}1{}}}]}}"#,
            "[".repeat(998),
            "]".repeat(998)
        );
        assert!(plan(&parse(&ok)).is_ok());
        // Unknown modules are never walked (parsing this deep needs the binary's large stack).
        let walked = std::thread::Builder::new()
            .stack_size(64 * 1024 * 1024)
            .spawn(|| {
                let unknown = format!(r#"{{"Otro":[{}]}}"#, "[".repeat(5000) + &"]".repeat(5000));
                plan(&parse(&unknown)).is_ok()
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
        let plan = plan(&seed).unwrap_or_default();
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
}
