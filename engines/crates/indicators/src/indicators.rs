//! Indicators v0.4 (app.py:1342-1617; apps/api/src/contexts/indicators/domain/indicators.ts).
//! Provisional, transparent rules/proxies over a tenant's module records.

use crate::error::EngineError;
use crate::js;
use crate::python::{first_truthy, py_float, py_round, py_str, text};
use crate::records::{F, Module, Records, Row, Slot};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};

/// Dimensions in evaluation order with their labels (`DIM_LABELS`).
pub const DIMENSIONS: [(&str, &str); 6] = [
    ("G", "Gobernanza y representación"),
    ("A", "Actores e influencia"),
    ("D", "Demandas y compromisos"),
    ("N", "Narrativas y señales digitales"),
    ("E", "Ambiental-territorial"),
    ("I", "Institucional y trazabilidad"),
];

/// Modules the rules read (`INDICATOR_MODULES`); any other module in the input is ignored.
pub const INDICATOR_MODULES: [&str; 8] = [
    "Eventos",
    "Actores",
    "Demandas",
    "Compromisos",
    "Narrativas",
    "Alertas",
    "Acciones",
    "Directorio_Territorial",
];

/// `VALIDATION_STATUS`.
pub const VALIDATION_STATUS: &str = "PROVISIONAL / PENDIENTE DE VALIDACIÓN DE EXPERTOS";
const METHOD_NOTE: &str = "V0.4 usa reglas/proxies transparentes. Indicadores con datos insuficientes se excluyen del promedio dimensional.";
const AVAILABLE: &str = "Disponible";

type Result<T> = std::result::Result<T, EngineError>;

/// The indicator modules as the rules see them.
struct Modules<'a> {
    eventos: Vec<&'a Row>,
    actores: Vec<&'a Row>,
    demandas: Vec<&'a Row>,
    compromisos: Vec<&'a Row>,
    narrativas: Vec<&'a Row>,
    alertas: Vec<&'a Row>,
    acciones: Vec<&'a Row>,
    directorio: Vec<&'a Row>,
}

impl<'a> Modules<'a> {
    /// A missing or non-array module and a `null` record are rejected (TypeScript throws).
    fn new(records: &'a Records) -> Result<Self> {
        let Some(modules) = &records.modules else {
            return Err(EngineError::input(
                "records must be an object of module arrays",
            ));
        };
        let module = |i: usize| -> Result<Vec<&'a Row>> {
            let name = INDICATOR_MODULES.get(i).copied().unwrap_or("?");
            let Some(Some(Module::Rows(rows))) = modules.get(i) else {
                return Err(EngineError::input(format!(
                    "records.{name} must be an array"
                )));
            };
            rows.iter()
                .enumerate()
                .map(|(j, slot)| match slot {
                    Slot::Row(row) => Ok(row),
                    Slot::Null => Err(EngineError::input(format!("records.{name}[{j}] is null"))),
                })
                .collect()
        };
        Ok(Self {
            eventos: module(0)?,
            actores: module(1)?,
            demandas: module(2)?,
            compromisos: module(3)?,
            narrativas: module(4)?,
            alertas: module(5)?,
            acciones: module(6)?,
            directorio: module(7)?,
        })
    }
}

/// `txt(...)`: the fields' text joined by spaces, lowercased. Lowercasing each part equals
/// lowercasing the join: a space isolates the parts (`records::tests` pins it over Unicode).
fn txt(row: &Row, keys: &[F]) -> String {
    keys.iter()
        .map(|k| row.lower(*k))
        .collect::<Vec<_>>()
        .join(" ")
}

/// `contains(value, words)` on lowercase text: TypeScript lowercases it once more, a no-op
/// because lowercasing is idempotent (pinned in `records::tests`).
fn contains(lower: &str, words: &[&str]) -> bool {
    words.iter().any(|w| lower.contains(w))
}

/// `contains(record[key], words)`.
fn has(row: &Row, key: F, words: &[&str]) -> bool {
    contains(row.lower(key), words)
}

fn count<'a>(rows: impl IntoIterator<Item = &'a &'a Row>, pred: impl Fn(&Row) -> bool) -> usize {
    rows.into_iter().filter(|r| pred(r)).count()
}

#[allow(clippy::cast_precision_loss)] // record counts are far below 2^53
fn float(n: usize) -> f64 {
    n as f64
}

/// `pct(num, den)`.
fn pct(num: usize, den: usize) -> Result<f64> {
    if den == 0 {
        Ok(0.0)
    } else {
        py_round(100.0 * float(num) / float(den), 2)
    }
}

fn min100(x: f64) -> f64 {
    x.min(100.0)
}

const DIMENSION_WORDS: [(&str, char); 12] = [
    ("gobernanza", 'G'),
    ("representación", 'G'),
    ("actores", 'A'),
    ("influencia", 'A'),
    ("demandas", 'D'),
    ("compromisos", 'D'),
    ("narrativas", 'N'),
    ("digitales", 'N'),
    ("ambiental", 'E'),
    ("territorial", 'E'),
    ("institucional", 'I'),
    ("trazabilidad", 'I'),
];

/// app.py `dimension_code`.
#[must_use]
pub fn dimension_code(value: Option<&Value>) -> Option<char> {
    let raw = text(value);
    if raw.is_empty() {
        return None;
    }
    let s = js::trim(&raw);
    if let Some(first) = s.chars().next().filter(|c| "GADNEI".contains(*c)) {
        return Some(first);
    }
    let low = s.to_lowercase();
    DIMENSION_WORDS
        .iter()
        .find(|(word, _)| low.contains(word))
        .map(|&(_, d)| d)
}

const CLOSED_STATES: [&str; 9] = [
    "cerrada",
    "cerrado",
    "descartada",
    "descartado",
    "cumplido",
    "cumplida",
    "cancelado",
    "cancelada",
    "atendida",
];

/// app.py `is_open_state`.
#[must_use]
pub fn is_open_state(value: Option<&Value>) -> bool {
    let state = js::trim(&text(value)).to_lowercase();
    !CLOSED_STATES.contains(&state.as_str())
}

fn dim_of(record: &Row, key: F) -> Option<char> {
    dimension_code(record.get(key))
}

fn in_dimension(record: &Row, d: char) -> bool {
    dim_of(record, F::DimensionPrincipal) == Some(d)
        || dim_of(record, F::DimensionSecundaria) == Some(d)
}

/// An indicator before its metadata is attached (`RawIndicator`).
struct Raw {
    code: &'static str,
    score: Option<f64>,
    confidence: &'static str,
    method: &'static str,
    evidence_count: usize,
    explanation: String,
    availability: &'static str,
}

/// `ind(...)`: clamps and rounds the score to `[0, 100]`.
fn ind(
    code: &'static str,
    score: Option<f64>,
    confidence: &'static str,
    method: &'static str,
    evidence_count: usize,
    explanation: String,
    availability: &'static str,
) -> Result<Raw> {
    let score = match score {
        Some(x) => Some(py_round(x.clamp(0.0, 100.0), 2)?),
        None => None,
    };
    Ok(Raw {
        code,
        score,
        confidence,
        method,
        evidence_count,
        explanation,
        availability,
    })
}

const GOV_ACTOR_WORDS: &[&str] = &[
    "comunal",
    "represent",
    "fundación",
    "administrador",
    "ccsms",
];
const RISKY_LEG_WORDS: &[&str] = &[
    "fragment",
    "limitad",
    "validar",
    "provisional",
    "inciert",
    "sin reconocimiento",
];
const CONFLICT_WORDS: &[&str] = &[
    "disputa",
    "enfrentamiento",
    "conflicto",
    "facción",
    "facciones",
    "tensión",
    "controversia",
];
const LEGAL_WORDS: &[&str] = &[
    "judicial",
    "resolución",
    "registr",
    "sunarp",
    "bdpi",
    "consulta previa",
    "tribunal",
    "apelación",
    "fiscal",
];
const LEAD_WORDS: &[&str] = &[
    "elección",
    "electoral",
    "padrón",
    "junta",
    "administrador",
    "liderazgo",
    "directiva",
    "empadron",
];

#[allow(clippy::too_many_lines)] // one rule block per indicator, mirroring the TypeScript source
fn governance(r: &Modules) -> Result<Vec<Raw>> {
    let gov_actors: Vec<&&Row> = r
        .actores
        .iter()
        .filter(|a| {
            contains(
                &txt(
                    a,
                    &[F::TipoActor, F::RolRelacion, F::LegitimidadRepresentacion],
                ),
                GOV_ACTOR_WORDS,
            )
        })
        .collect();
    let risky_leg = count(gov_actors.iter().copied(), |a| {
        has(a, F::LegitimidadRepresentacion, RISKY_LEG_WORDS)
    });
    let g_events: Vec<&&Row> = r.eventos.iter().filter(|e| in_dimension(e, 'G')).collect();
    let g_high = count(g_events.iter().copied(), |e| {
        has(e, F::RelevanciaPreliminar, &["alta", "crít", "crit"])
    });
    let g_alerts = count(&r.alertas, |a| {
        dim_of(a, F::Dimension) == Some('G') && is_open_state(a.get(F::Estado))
    });
    let g_conf = count(g_events.iter().copied(), |e| {
        contains(
            &txt(
                e,
                &[F::DescripcionHecho, F::EvidenciaResultado, F::Observaciones],
            ),
            CONFLICT_WORDS,
        )
    });
    let n_conf = count(&r.narrativas, |n| {
        contains(&txt(n, &[F::Tema, F::Descripcion]), CONFLICT_WORDS)
    });
    let legal = count(&r.eventos, |e| {
        contains(
            &txt(
                e,
                &[
                    F::TipoEvento,
                    F::DescripcionHecho,
                    F::EvidenciaResultado,
                    F::Observaciones,
                ],
            ),
            LEGAL_WORDS,
        )
    });
    let lead = count(&r.eventos, |e| {
        contains(
            &txt(
                e,
                &[F::TipoEvento, F::DescripcionHecho, F::EvidenciaResultado],
            ),
            LEAD_WORDS,
        )
    });
    let gov = gov_actors.len();
    Ok(vec![
        ind(
            "G1",
            Some(pct(risky_leg, gov.max(1))?),
            "Media-Alta",
            "Proporción de actores de gobernanza con legitimidad/representación fragmentada, limitada o pendiente de validar.",
            gov,
            format!(
                "{risky_leg} de {gov} actores de gobernanza presentan condiciones de representación que requieren validación."
            ),
            AVAILABLE,
        )?,
        ind(
            "G2",
            Some(min100(float(g_high * 8 + g_alerts * 18))),
            "Alta",
            "Suma normalizada de eventos G de relevancia alta/crítica y alertas G activas.",
            g_high + g_alerts,
            format!("{g_high} eventos G relevantes y {g_alerts} alertas G activas."),
            AVAILABLE,
        )?,
        ind(
            "G3",
            Some(min100(float((g_conf + n_conf) * 15))),
            "Media-Alta",
            "Conteo normalizado de eventos y narrativas con términos de disputa/conflicto vinculados al entorno de gobernanza.",
            g_conf + n_conf,
            format!(
                "Se identificaron {g_conf} eventos y {n_conf} narrativas con señales de conflictividad interna."
            ),
            AVAILABLE,
        )?,
        ind(
            "G4",
            Some(min100(float(legal * 12))),
            "Alta",
            "Conteo normalizado de eventos con elementos judiciales, registrales, BDPI/consulta previa o apelaciones.",
            legal,
            format!("{legal} eventos contienen factores jurídicos/registrales relevantes."),
            AVAILABLE,
        )?,
        ind(
            "G5",
            Some(min100(float(lead * 10))),
            "Media-Alta",
            "Conteo normalizado de eventos relacionados con elecciones, padrón, directivas o administraciones provisionales.",
            lead,
            format!("{lead} eventos reflejan cambios o procesos de liderazgo/interlocución."),
            AVAILABLE,
        )?,
    ])
}

const LEG_RISK_WORDS: &[&str] = &[
    "validar",
    "fragment",
    "limitad",
    "provisional",
    "inciert",
    "por confirmar",
];
const POL_WORDS: &[&str] = &[
    "polar",
    "facción",
    "alianza",
    "oposición",
    "tensión",
    "confront",
    "disputa",
    "enfrent",
];

fn actors(r: &Modules) -> Result<Vec<Raw>> {
    let total = r.actores.len();
    let highinf = count(&r.actores, |a| {
        has(a, F::Influencia, &["alta"])
            && has(a, F::PosicionProyecto, &["crít", "opos", "no determinado"])
    });
    let mobil = count(&r.actores, |a| {
        has(a, F::CapacidadMovilizacion, &["alta", "media-alta"])
    });
    // Centrality proxy: concentration of actor mentions as principal actor in events.
    let mut mentions: BTreeMap<String, usize> = BTreeMap::new();
    for e in &r.eventos {
        let actor = e.text(F::ActorPrincipal).to_owned();
        let actor = js::trim(&actor);
        if !actor.is_empty() {
            *mentions.entry(actor.to_owned()).or_default() += 1;
        }
    }
    let top = mentions.values().copied().max().unwrap_or(0);
    let leg_risk = count(&r.actores, |a| {
        contains(
            &txt(a, &[F::LegitimidadRepresentacion, F::Observaciones]),
            LEG_RISK_WORDS,
        )
    });
    let pol = count(&r.eventos, |e| {
        contains(&txt(e, &[F::DescripcionHecho, F::Observaciones]), POL_WORDS)
    }) + count(&r.narrativas, |n| {
        contains(&txt(n, &[F::Tema, F::Descripcion]), POL_WORDS)
    });
    let events = r.eventos.len();
    Ok(vec![
        ind(
            "A1",
            Some(pct(highinf, total.max(1))?),
            "Media-Alta",
            "Proporción de actores con influencia alta y posición crítica/opositora/no determinada.",
            total,
            format!("{highinf} de {total} actores analíticos cumplen la condición de riesgo."),
            AVAILABLE,
        )?,
        ind(
            "A2",
            Some(pct(mobil, total.max(1))?),
            "Alta",
            "Proporción de actores con capacidad de movilización alta o media-alta.",
            total,
            format!("{mobil} de {total} actores tienen capacidad de movilización relevante."),
            AVAILABLE,
        )?,
        // No historical actor-position series exists in the structured base.
        ind(
            "A3",
            None,
            "Baja",
            "No calculable de forma robusta: falta serie histórica estructurada de posición por actor.",
            0,
            "La base almacena una posición vigente por actor, pero no un historial suficiente para medir cambios.".to_owned(),
            "Datos insuficientes",
        )?,
        ind(
            "A4",
            Some(pct(top, events.max(1))?),
            "Media",
            "Proxy de centralidad: participación del actor más mencionado como actor principal sobre el total de eventos.",
            events,
            format!("El actor más mencionado concentra {top} de {events} eventos. Requiere reemplazo futuro por análisis de red formal."),
            AVAILABLE,
        )?,
        ind(
            "A5",
            Some(pct(leg_risk, total.max(1))?),
            "Media",
            "Proporción de actores analíticos con legitimidad/representación pendiente, provisional o limitada.",
            total,
            format!("{leg_risk} de {total} actores requieren cautela de legitimidad/representación."),
            AVAILABLE,
        )?,
        ind(
            "A6",
            Some(min100(float(pol * 12))),
            "Media",
            "Conteo normalizado de eventos/narrativas con señales de polarización, facciones, alianzas o tensión.",
            pol,
            format!("{pol} registros contienen señales relacionales de polarización o tensión."),
            AVAILABLE,
        )?,
    ])
}

const GAP_WORDS: &[&str] = &[
    "futuro adjudicatario",
    "por definir",
    "según etapa",
    "segun etapa",
    "según competencia",
    "segun competencia",
    "entidad competente",
    "instancia técnica",
    "instancia tecnica",
];

fn demands(r: &Modules) -> Result<Vec<Raw>> {
    let total = r.demandas.len();
    let commitments = r.compromisos.len();
    let open = count(&r.demandas, |d| is_open_state(d.get(F::Estado)));
    let rec = count(&r.demandas, |d| has(d, F::Recurrencia, &["alta"]));
    let overdue = count(&r.compromisos, |c| has(c, F::Estado, &["vencid"]));
    let slow = count(&r.demandas, |d| has(d, F::Estado, &["nueva", "evaluada"]));
    let pend = count(&r.compromisos, |c| has(c, F::Estado, &["pendiente"]));
    let gap = count(&r.demandas, |d| {
        contains(
            &txt(d, &[F::EntidadCompetente, F::Observaciones]),
            GAP_WORDS,
        )
    });
    Ok(vec![
        ind(
            "D1",
            Some(min100(float(open * 7))),
            "Alta",
            "Número de demandas abiertas normalizado a 0–100.",
            open,
            format!("{open} demandas permanecen abiertas o no cerradas."),
            AVAILABLE,
        )?,
        ind(
            "D2",
            Some(pct(rec, total.max(1))?),
            "Alta",
            "Porcentaje de demandas con recurrencia alta.",
            total,
            format!("{rec} de {total} demandas están marcadas con recurrencia alta."),
            AVAILABLE,
        )?,
        ind(
            "D3",
            Some(pct(overdue, commitments.max(1))?),
            "Alta",
            "Porcentaje de compromisos en estado vencido.",
            commitments,
            format!(
                "{overdue} de {commitments} compromisos están vencidos según el registro actual."
            ),
            AVAILABLE,
        )?,
        ind(
            "D4",
            Some(min100(float((slow + pend) * 10))),
            "Baja-Media",
            "Proxy por demandas en estado inicial y compromisos pendientes. No sustituye un cálculo de días de respuesta.",
            slow + pend,
            format!(
                "{slow} demandas están en estados iniciales y {pend} compromisos están pendientes."
            ),
            "Proxy por datos incompletos",
        )?,
        ind(
            "D5",
            Some(pct(gap, total.max(1))?),
            "Media-Alta",
            "Proporción de demandas cuya atención depende de futura etapa, entidad o competencia por precisar.",
            total,
            format!("{gap} de {total} demandas presentan brecha expectativa–competencia/etapa."),
            AVAILABLE,
        )?,
    ])
}

const DIG_CONF_WORDS: &[&str] = &[
    "controvers",
    "conflicto",
    "tensión",
    "disputa",
    "enfrent",
    "polar",
    "cuestion",
];

fn narratives(r: &Modules) -> Result<Vec<Raw>> {
    let total = r.narrativas.len();
    let n = total.max(1);
    let critical = count(&r.narrativas, |x| {
        has(x, F::Tono, &["negativo"]) && has(x, F::Intensidad, &["alta"])
    });
    let active = count(&r.narrativas, |x| is_open_state(x.get(F::Estado)));
    let dig_conf = count(&r.narrativas, |x| {
        contains(&txt(x, &[F::Tema, F::Descripcion]), DIG_CONF_WORDS)
    });
    let unver = count(&r.narrativas, |x| {
        has(x, F::NivelVerificacion, &["e -", "no verificada"])
            || has(x, F::NivelVerificacion, &["d - opinión", "d - opinion"])
    });
    let themes: BTreeSet<String> = r
        .narrativas
        .iter()
        .map(|x| js::trim(x.text(F::Tema)).to_lowercase())
        .filter(|t| !t.is_empty())
        .collect();
    let themes = themes.len();
    Ok(vec![
        ind(
            "N1",
            Some(pct(critical, n)?),
            "Alta",
            "Porcentaje de narrativas con tono negativo e intensidad alta.",
            total,
            format!("{critical} de {total} narrativas cumplen el criterio de contenido crítico."),
            AVAILABLE,
        )?,
        ind(
            "N2",
            Some(pct(active, n)?),
            "Media",
            "Proporción de narrativas que permanecen en seguimiento/activas. Es un proxy de persistencia, no una tasa temporal.",
            total,
            format!("{active} de {total} narrativas permanecen abiertas/en seguimiento."),
            "Proxy temporal",
        )?,
        ind(
            "N3",
            Some(pct(dig_conf, n)?),
            "Media-Alta",
            "Porcentaje de narrativas con términos asociados a confrontación o controversia.",
            total,
            format!(
                "{dig_conf} de {total} narrativas muestran señales de confrontación/controversia."
            ),
            AVAILABLE,
        )?,
        ind(
            "N4",
            Some(pct(unver, n)?),
            "Alta",
            "Porcentaje de narrativas clasificadas como opinión/narrativa o no verificadas.",
            total,
            format!("{unver} de {total} narrativas requieren cautela de verificación."),
            AVAILABLE,
        )?,
        ind(
            "N5",
            Some(min100(float(themes * 12))),
            "Baja-Media",
            "Número de temas distintos normalizado como proxy de diversificación de la agenda narrativa.",
            themes,
            format!(
                "El monitoreo registra {themes} temas distintos. Se requiere una serie temporal mayor para identificar emergencia real."
            ),
            "Proxy por serie limitada",
        )?,
    ])
}

const LIVELIHOODS: [(&str, &[&str]); 5] = [
    ("pesca", &["pesca", "pescador"]),
    ("maricultura", &["maricult"]),
    ("ganadería", &["ganad"]),
    ("agricultura", &["agric"]),
    ("transporte", &["transport"]),
];
const ENV_WORDS: &[&str] = &[
    "agua",
    "pesca",
    "maricultura",
    "ambient",
    "territor",
    "servid",
    "biodivers",
    "pozo",
    "ganad",
    "agric",
    "polvo",
    "bahía",
    "bahia",
    "tránsito",
    "transito",
];
const TERR_WORDS: &[&str] = &[
    "territorio",
    "servidumbre",
    "tránsito",
    "transito",
    "superficie",
    "acceso",
    "delimitación",
    "delimitacion",
    "ruta",
    "pozo hierba blanca",
];

#[allow(clippy::too_many_lines)] // one rule block per indicator, mirroring the TypeScript source
fn environment(r: &Modules) -> Result<Vec<Raw>> {
    let env_dem: Vec<&&Row> = r
        .demandas
        .iter()
        .filter(|d| {
            dim_of(d, F::Dimension) == Some('E')
                || contains(&txt(d, &[F::Tema, F::Descripcion]), ENV_WORDS)
        })
        .collect();
    let env_evt: Vec<&&Row> = r
        .eventos
        .iter()
        .filter(|e| in_dimension(e, 'E') || has(e, F::DescripcionHecho, ENV_WORDS))
        .collect();
    let active_env_dem = count(env_dem.iter().copied(), |d| is_open_state(d.get(F::Estado)));
    let env_rec = count(env_dem.iter().copied(), |d| {
        has(d, F::Recurrencia, &["alta"])
    });
    let demand_text: Vec<String> = r
        .demandas
        .iter()
        .map(|d| txt(d, &[F::ActorGrupo, F::Tema, F::Descripcion]))
        .collect();
    let event_text: Vec<String> = r
        .eventos
        .iter()
        .map(|e| txt(e, &[F::ActorPrincipal, F::DescripcionHecho]))
        .collect();
    let corpus = format!("{} {}", demand_text.join(" "), event_text.join(" "));
    let exposed: Vec<&str> = LIVELIHOODS
        .iter()
        .filter(|(_, words)| contains(&corpus, words))
        .map(|&(sector, _)| sector)
        .collect();
    let terr = count(r.demandas.iter().chain(&r.eventos), |x| {
        contains(
            &txt(
                x,
                &[
                    F::Tema,
                    F::Descripcion,
                    F::DescripcionHecho,
                    F::Observaciones,
                ],
            ),
            TERR_WORDS,
        )
    });
    let verified = count(env_evt.iter().copied(), |e| {
        has(e, F::NivelVerificacion, &["a -", "b -"])
    });
    let perceived = count(env_evt.iter().copied(), |e| {
        has(e, F::NivelVerificacion, &["c -", "d -", "e -"])
    });
    let (n_dem, n_evt, n_exposed) = (env_dem.len(), env_evt.len(), exposed.len());
    let sectors = if exposed.is_empty() {
        "ninguno estructurado".to_owned()
    } else {
        exposed.join(", ")
    };
    Ok(vec![
        ind(
            "E1",
            Some(min100(float(active_env_dem * 8 + n_evt * 4))),
            "Alta",
            "Suma normalizada de demandas ambientales abiertas y eventos ambientales/territoriales.",
            active_env_dem + n_evt,
            format!(
                "{active_env_dem} demandas ambientales abiertas y {n_evt} eventos relacionados."
            ),
            AVAILABLE,
        )?,
        ind(
            "E2",
            Some(pct(env_rec, n_dem.max(1))?),
            "Alta",
            "Porcentaje de demandas ambientales/territoriales con recurrencia alta.",
            n_dem,
            format!("{env_rec} de {n_dem} demandas ambientales son recurrentes."),
            AVAILABLE,
        )?,
        ind(
            "E3",
            Some(min100(float(n_exposed * 18))),
            "Media-Alta",
            "Diversidad de medios de vida identificados en demandas/eventos, normalizada a 0–100.",
            n_exposed,
            format!("Se identifican {n_exposed} sectores: {sectors}."),
            AVAILABLE,
        )?,
        ind(
            "E4",
            Some(min100(float(terr * 10))),
            "Alta",
            "Conteo normalizado de registros con uso de territorio, servidumbres, accesos, rutas o delimitación.",
            terr,
            format!("{terr} registros contienen asuntos de territorio/acceso/servidumbre."),
            AVAILABLE,
        )?,
        ind(
            "E5",
            Some(pct(perceived, (verified + perceived).max(1))?),
            "Media-Alta",
            "Porcentaje de eventos ambientales sustentados en percepción/opinión/no verificado frente al total ambiental con nivel de verificación.",
            verified + perceived,
            format!(
                "{perceived} eventos ambientales se basan en percepción/opinión y {verified} están verificados/corroborados."
            ),
            AVAILABLE,
        )?,
    ])
}

const OPEN_ACTION: &[&str] = &["pendiente", "en curso", "vencid"];
const MSG_WORDS: &[&str] = &[
    "contradic",
    "desinform",
    "precisar",
    "aclar",
    "carácter informativo",
    "caracter informativo",
    "alcance",
    "no asumir",
];

/// Lowercased distinct non-empty trimmed values (`new Set(... .trim() ... .toLowerCase())`).
fn distinct<'a>(values: impl Iterator<Item = Option<&'a Value>>) -> BTreeSet<String> {
    values
        .map(|v| js::trim(&text(v)).to_owned())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_lowercase())
        .collect()
}

#[allow(clippy::too_many_lines)] // one rule block per indicator, mirroring the TypeScript source
fn institutional(r: &Modules) -> Result<Vec<Raw>> {
    let i_alerts = count(&r.alertas, |a| {
        dim_of(a, F::Dimension) == Some('I') && is_open_state(a.get(F::Estado))
    });
    // Later alerts with the same id replace earlier ones, like `new Map(entries)`.
    let alert_map: BTreeMap<String, Option<char>> = r
        .alertas
        .iter()
        .map(|a| {
            (
                py_str(first_truthy(&[a.get(F::IdAlerta), a.get(F::Id)])),
                dim_of(a, F::Dimension),
            )
        })
        .collect();
    let i_actions = count(&r.acciones, |a| {
        alert_map.get(a.text(F::IdAlerta)) == Some(&Some('I')) && has(a, F::Estado, OPEN_ACTION)
    });
    let msg: Vec<&&Row> = r.eventos.iter().filter(|e| in_dimension(e, 'I')).collect();
    let msg_risk = count(msg.iter().copied(), |e| {
        contains(
            &txt(
                e,
                &[F::DescripcionHecho, F::EvidenciaResultado, F::Observaciones],
            ),
            MSG_WORDS,
        )
    });
    let open_actions = count(&r.acciones, |a| has(a, F::Estado, OPEN_ACTION));
    let active: Vec<&&Row> = r
        .alertas
        .iter()
        .filter(|a| is_open_state(a.get(F::Estado)))
        .collect();
    let noresp = count(active.iter().copied(), |a| {
        js::trim(a.text(F::Responsable)).is_empty() || has(a, F::Responsable, &["por asignar"])
    });
    let key_records: Vec<&&Row> = r
        .eventos
        .iter()
        .chain(&r.demandas)
        .chain(&r.alertas)
        .chain(&r.acciones)
        .chain(&r.narrativas)
        .collect();
    let with_source = count(key_records.iter().copied(), |x| {
        let evidence = first_truthy(&[
            x.get(F::Evidencia),
            x.get(F::EvidenciaResultado),
            x.get(F::EvidenciaCierre),
        ]);
        !js::trim(x.text(F::FuenteId)).is_empty() || !js::trim(&text(evidence)).is_empty()
    });
    let n_key = key_records.len();
    let completeness = pct(with_source, n_key.max(1))?;
    let territories = distinct(
        r.eventos
            .iter()
            .chain(&r.demandas)
            .map(|x| x.get(F::Territorio)),
    )
    .len();
    // Directory: conservative reference of distinct territorial sections when available.
    let dir_places = distinct(
        r.directorio
            .iter()
            .map(|x| first_truthy(&[x.get(F::SeccionTerritorial), x.get(F::LugarAmbito)])),
    )
    .len();
    let denom = (if dir_places == 0 {
        territories
    } else {
        dir_places
    })
    .max(1);
    let coverage_pct = pct(territories, denom)?;
    let coverage = coverage_pct.min(100.0);
    // Python min(100, x) keeps the int 100 when x >= 100, which changes its text form.
    let coverage_text = if coverage_pct >= 100.0 {
        "100".to_owned()
    } else {
        py_float(coverage)
    };
    let (n_msg, n_active) = (msg.len(), active.len());
    Ok(vec![
        ind(
            "I1",
            Some(min100(float(i_alerts * 18 + i_actions * 8))),
            "Media-Alta",
            "Alertas institucionales activas y acciones institucionales pendientes como proxy de coordinación residual.",
            i_alerts + i_actions,
            format!("{i_alerts} alertas I activas y {i_actions} acciones I pendientes/en curso."),
            AVAILABLE,
        )?,
        ind(
            "I2",
            Some(pct(msg_risk, n_msg.max(1))?),
            "Media",
            "Porcentaje de eventos institucionales que requieren precisión, aclaración o cautela de mensaje.",
            n_msg,
            format!(
                "{msg_risk} de {n_msg} eventos institucionales presentan señales de coherencia/mensaje por gestionar."
            ),
            AVAILABLE,
        )?,
        ind(
            "I3",
            Some(min100(float(i_alerts * 12 + open_actions * 4))),
            "Baja-Media",
            "Proxy basado en alertas institucionales activas y acciones abiertas. No es un cálculo de días de respuesta.",
            i_alerts + open_actions,
            format!("{i_alerts} alertas I activas y {open_actions} acciones generales abiertas."),
            "Proxy por fechas incompletas",
        )?,
        ind(
            "I4",
            Some(pct(noresp, n_active.max(1))?),
            "Alta",
            "Porcentaje de alertas activas sin responsable definido o marcadas 'Por asignar'.",
            n_active,
            format!("{noresp} de {n_active} alertas activas no tienen responsable efectivo."),
            AVAILABLE,
        )?,
        ind(
            "I5",
            Some(100.0 - completeness),
            "Alta",
            "Riesgo inverso del porcentaje de registros clave con Fuente_ID o evidencia asociada.",
            n_key,
            format!(
                "{with_source} de {n_key} registros clave cuentan con fuente/evidencia estructurada ({}%).",
                py_float(completeness)
            ),
            AVAILABLE,
        )?,
        ind(
            "I6",
            Some(100.0 - coverage),
            "Media",
            "Riesgo inverso de la cobertura: territorios presentes en eventos/demandas frente a ámbitos diferenciados del directorio.",
            territories,
            format!(
                "Se cubren {territories} territorios en registros operativos frente a {denom} ámbitos de referencia; cobertura estimada {coverage_text}%."
            ),
            "Indicador de cobertura aproximada",
        )?,
    ])
}

fn rules(d: &str, r: &Modules) -> Result<Vec<Raw>> {
    match d {
        "G" => governance(r),
        "A" => actors(r),
        "D" => demands(r),
        "N" => narratives(r),
        "E" => environment(r),
        _ => institutional(r),
    }
}

/// Metadata entries of one dimension keyed by code; later entries win (`new Map(...)`).
fn meta_by_code<'a>(
    meta: &'a Map<String, Value>,
    d: &str,
) -> Result<BTreeMap<&'a str, &'a Map<String, Value>>> {
    let entries = match meta.get(d) {
        None | Some(Value::Null) => return Ok(BTreeMap::new()),
        Some(Value::Array(entries)) => entries,
        Some(_) => return Err(EngineError::input(format!("meta.{d} must be an array"))),
    };
    let mut by_code = BTreeMap::new();
    for (i, entry) in entries.iter().enumerate() {
        match entry {
            Value::Object(m) => {
                // A non-string code never equals an indicator code, so it can never match.
                if let Some(Value::String(code)) = m.get("code") {
                    by_code.insert(code.as_str(), m);
                }
            }
            Value::Null => return Err(EngineError::input(format!("meta.{d}[{i}] is null"))),
            _ => {}
        }
    }
    Ok(by_code)
}

/// app.py `compute_indicators`: indicator scores, metadata and per-dimension aggregation.
///
/// # Errors
/// `InvalidInput` when a module is missing or not an array, a record is `null`, or `meta` has an
/// invalid shape (the TypeScript engine throws in those cases).
pub fn compute_indicators(records: &Records, meta: &Value) -> Result<Value> {
    let records = Modules::new(records)?;
    let Value::Object(meta) = meta else {
        return Err(EngineError::input(
            "meta must be an object of dimension arrays",
        ));
    };
    let mut dimensions = Map::new();
    let mut scores = Map::new();
    let mut availability = Map::new();
    let mut flat = Vec::new();
    for (d, label) in DIMENSIONS {
        let raw = rules(d, &records)?;
        let by_code = meta_by_code(meta, d)?;
        let available: Vec<f64> = raw.iter().filter_map(|x| x.score).collect();
        let score = if available.is_empty() {
            0.0
        } else {
            py_round(
                available.iter().fold(0.0, |a, b| a + b) / float(available.len()),
                2,
            )?
        };
        let share = if raw.is_empty() {
            0.0
        } else {
            py_round(100.0 * float(available.len()) / float(raw.len()), 1)?
        };
        scores.insert(d.to_owned(), js::number(score));
        availability.insert(d.to_owned(), js::number(share));
        let mut items = Vec::with_capacity(raw.len());
        for x in raw {
            let mut v = Map::new();
            v.insert("code".into(), Value::String(x.code.into()));
            v.insert("score".into(), x.score.map_or(Value::Null, js::number));
            v.insert("confidence".into(), Value::String(x.confidence.into()));
            v.insert("method".into(), Value::String(x.method.into()));
            v.insert("evidence_count".into(), Value::from(x.evidence_count));
            v.insert("explanation".into(), Value::String(x.explanation));
            v.insert("availability".into(), Value::String(x.availability.into()));
            if let Some(m) = by_code.get(x.code) {
                // `{ code, name, definition }` from the metadata; undefined fields are omitted.
                for key in ["code", "name", "definition"] {
                    if let Some(value) = m.get(key) {
                        v.insert(key.into(), value.clone());
                    }
                }
            }
            v.insert("dimension".into(), Value::String(d.into()));
            v.insert("dimension_label".into(), Value::String(label.into()));
            let v = Value::Object(v);
            flat.push(v.clone());
            items.push(v);
        }
        dimensions.insert(d.to_owned(), Value::Array(items));
    }
    let mut report = Map::new();
    report.insert("dimensions".into(), Value::Object(dimensions));
    report.insert("dimension_scores".into(), Value::Object(scores));
    report.insert("availability".into(), Value::Object(availability));
    report.insert("indicators".into(), Value::Array(flat));
    report.insert("method_note".into(), Value::String(METHOD_NOTE.into()));
    report.insert(
        "validation_status".into(),
        Value::String(VALIDATION_STATUS.into()),
    );
    Ok(Value::Object(report))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_word_list_is_lowercase() {
        let lists: [&[&str]; 14] = [
            GOV_ACTOR_WORDS,
            RISKY_LEG_WORDS,
            CONFLICT_WORDS,
            LEGAL_WORDS,
            LEAD_WORDS,
            LEG_RISK_WORDS,
            POL_WORDS,
            GAP_WORDS,
            DIG_CONF_WORDS,
            ENV_WORDS,
            TERR_WORDS,
            OPEN_ACTION,
            MSG_WORDS,
            &CLOSED_STATES,
        ];
        for word in lists.iter().flat_map(|l| l.iter()) {
            assert_eq!(*word, word.to_lowercase());
        }
    }

    #[test]
    fn dimension_codes() {
        let v = |s: &str| Value::String(s.to_owned());
        assert_eq!(dimension_code(Some(&v("G - Gobernanza"))), Some('G'));
        assert_eq!(dimension_code(Some(&v("\u{feff}E"))), Some('E'));
        assert_eq!(dimension_code(Some(&v("Institucional"))), Some('I'));
        assert_eq!(dimension_code(Some(&v("institucional"))), Some('I'));
        assert_eq!(dimension_code(Some(&v("  "))), None);
        assert_eq!(dimension_code(None), None);
    }
}
