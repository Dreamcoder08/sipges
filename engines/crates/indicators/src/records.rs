//! Module records parsed straight from the request JSON into compact rows that keep only the
//! fields the indicator rules read. Skipping the rest (and every non-indicator module) avoids
//! building a full JSON tree; the rules only ever read these fields, so results are unchanged.

use crate::python::text;
use serde::Deserializer;
use serde::de::{self, DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde_json::Value;
use std::cell::OnceCell;
use std::fmt;

macro_rules! fields {
    ($($variant:ident => $name:literal,)*) => {
        /// A record field the rules read.
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub(crate) enum F { $($variant,)* }

        impl F {
            fn from_name(name: &str) -> Option<Self> {
                match name {
                    $($name => Some(Self::$variant),)*
                    _ => None,
                }
            }
        }
    };
}

fields! {
    Id => "_id",
    ActorGrupo => "Actor/Grupo",
    ActorPrincipal => "Actor_Principal",
    CapacidadMovilizacion => "Capacidad_Movilizacion",
    Descripcion => "Descripcion",
    DescripcionHecho => "Descripcion_Hecho",
    Dimension => "Dimension",
    DimensionPrincipal => "Dimension_Principal",
    DimensionSecundaria => "Dimension_Secundaria",
    EntidadCompetente => "Entidad_Competente",
    Estado => "Estado",
    Evidencia => "Evidencia",
    EvidenciaCierre => "Evidencia_Cierre",
    EvidenciaResultado => "Evidencia/Resultado",
    FuenteId => "Fuente_ID",
    IdAlerta => "ID_Alerta",
    Influencia => "Influencia",
    Intensidad => "Intensidad",
    LegitimidadRepresentacion => "Legitimidad/Representacion",
    LugarAmbito => "Lugar / ámbito",
    NivelVerificacion => "Nivel_Verificacion",
    Observaciones => "Observaciones",
    PosicionProyecto => "Posicion_Proyecto",
    Recurrencia => "Recurrencia",
    RelevanciaPreliminar => "Relevancia_Preliminar",
    Responsable => "Responsable",
    RolRelacion => "Rol/Relacion",
    SeccionTerritorial => "Sección territorial",
    Tema => "Tema",
    Territorio => "Territorio",
    TipoActor => "Tipo_Actor",
    TipoEvento => "Tipo_Evento",
    Tono => "Tono",
}

struct Field {
    id: F,
    value: Value,
    text: OnceCell<String>,
    lower: OnceCell<String>,
}

/// One record: the fields the rules read, with their Python text cached on first use.
#[derive(Default)]
pub(crate) struct Row {
    fields: Vec<Field>,
}

impl Row {
    /// `record[key]`; `None` is `undefined`.
    pub(crate) fn get(&self, id: F) -> Option<&Value> {
        self.fields.iter().find(|f| f.id == id).map(|f| &f.value)
    }

    /// `text(record[key])`.
    pub(crate) fn text(&self, id: F) -> &str {
        self.fields
            .iter()
            .find(|f| f.id == id)
            .map_or("", |f| f.text.get_or_init(|| text(Some(&f.value))))
    }

    /// `text(record[key]).toLowerCase()`.
    pub(crate) fn lower(&self, id: F) -> &str {
        self.fields.iter().find(|f| f.id == id).map_or("", |f| {
            f.lower
                .get_or_init(|| f.text.get_or_init(|| text(Some(&f.value))).to_lowercase())
        })
    }

    fn set(&mut self, id: F, value: Value) {
        // A repeated key keeps the last value, like JSON.parse.
        if let Some(field) = self.fields.iter_mut().find(|f| f.id == id) {
            field.value = value;
            field.text = OnceCell::new();
            field.lower = OnceCell::new();
        } else {
            self.fields.push(Field {
                id,
                value,
                text: OnceCell::new(),
                lower: OnceCell::new(),
            });
        }
    }
}

/// A record slot: `null` is kept apart because the TypeScript engine throws on it, while any
/// other non-object (number, string, array) reads every field as `undefined`.
pub(crate) enum Slot {
    Row(Row),
    Null,
}

/// A module value: an array of records, or anything else (an error for the rules).
pub(crate) enum Module {
    Rows(Vec<Slot>),
    Invalid,
}

/// The indicator modules of a request's `records`, in `INDICATOR_MODULES` order.
pub struct Records {
    pub(crate) modules: Option<[Option<Module>; 8]>,
}

const MODULES: [&str; 8] = crate::indicators::INDICATOR_MODULES;

/// Accepts any JSON value and reports `Invalid` unless it has the expected shape.
fn drain<'de, A: MapAccess<'de>>(mut map: A) -> Result<(), A::Error> {
    while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
    Ok(())
}

fn drain_seq<'de, A: SeqAccess<'de>>(mut seq: A) -> Result<(), A::Error> {
    while seq.next_element::<IgnoredAny>()?.is_some() {}
    Ok(())
}

macro_rules! scalars_as {
    ($value:expr) => {
        fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
            Ok($value)
        }
        fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> {
            Ok($value)
        }
        fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> {
            Ok($value)
        }
        fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> {
            Ok($value)
        }
        fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> {
            Ok($value)
        }
    };
}

struct KeySeed;

impl<'de> DeserializeSeed<'de> for KeySeed {
    type Value = Option<F>;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
        d.deserialize_str(self)
    }
}

impl Visitor<'_> for KeySeed {
    type Value = Option<F>;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a field name")
    }
    fn visit_str<E: de::Error>(self, key: &str) -> Result<Self::Value, E> {
        Ok(F::from_name(key))
    }
}

struct SlotSeed;

impl<'de> DeserializeSeed<'de> for SlotSeed {
    type Value = Slot;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for SlotSeed {
    type Value = Slot;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a record")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Slot, A::Error> {
        let mut row = Row::default();
        while let Some(key) = map.next_key_seed(KeySeed)? {
            match key {
                Some(id) => row.set(id, map.next_value::<Value>()?),
                None => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        Ok(Slot::Row(row))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> Result<Slot, A::Error> {
        drain_seq(seq)?;
        Ok(Slot::Row(Row::default()))
    }
    fn visit_unit<E: de::Error>(self) -> Result<Slot, E> {
        Ok(Slot::Null)
    }
    scalars_as!(Slot::Row(Row::default()));
}

struct ModuleSeed;

impl<'de> DeserializeSeed<'de> for ModuleSeed {
    type Value = Module;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for ModuleSeed {
    type Value = Module;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("an array of records")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Module, A::Error> {
        let mut rows = Vec::with_capacity(seq.size_hint().unwrap_or(0));
        while let Some(slot) = seq.next_element_seed(SlotSeed)? {
            rows.push(slot);
        }
        Ok(Module::Rows(rows))
    }
    fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Module, A::Error> {
        drain(map)?;
        Ok(Module::Invalid)
    }
    fn visit_unit<E: de::Error>(self) -> Result<Module, E> {
        Ok(Module::Invalid)
    }
    scalars_as!(Module::Invalid);
}

/// Deserializes a request's `records` value.
pub(crate) struct RecordsSeed;

impl<'de> DeserializeSeed<'de> for RecordsSeed {
    type Value = Records;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for RecordsSeed {
    type Value = Records;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("an object of module arrays")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Records, A::Error> {
        let mut modules: [Option<Module>; 8] = Default::default();
        while let Some(key) = map.next_key::<String>()? {
            match MODULES.iter().position(|m| *m == key) {
                Some(i) => {
                    let module = map.next_value_seed(ModuleSeed)?;
                    if let Some(slot) = modules.get_mut(i) {
                        *slot = Some(module);
                    }
                }
                None => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        Ok(Records {
            modules: Some(modules),
        })
    }
    fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> Result<Records, A::Error> {
        drain_seq(seq)?;
        Ok(Records { modules: None })
    }
    fn visit_unit<E: de::Error>(self) -> Result<Records, E> {
        Ok(Records { modules: None })
    }
    scalars_as!(Records { modules: None });
}

impl Records {
    /// Parses a `records` JSON value (an object of module arrays).
    ///
    /// # Errors
    /// Only on malformed JSON; shape problems are reported later by the rules.
    pub fn from_json(json: &[u8]) -> Result<Self, serde_json::Error> {
        let mut de = serde_json::Deserializer::from_slice(json);
        let records = RecordsSeed.deserialize(&mut de)?;
        de.end()?;
        Ok(records)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_last_duplicate_and_skips_unknown_fields() {
        let records = Records::from_json(
            br#"{"Eventos":[{"Tema":"a","x":{"deep":[1]},"Tema":"B"}],"Otro":[1]}"#,
        );
        let row = match records {
            Ok(Records {
                modules: Some(modules),
            }) => match modules.into_iter().next() {
                Some(Some(Module::Rows(mut rows))) if rows.len() == 1 => rows.pop(),
                _ => None,
            },
            _ => None,
        };
        assert!(
            matches!(&row, Some(Slot::Row(row)) if row.text(F::Tema) == "B"
                && row.lower(F::Tema) == "b"
                && row.fields.len() == 1),
            "expected one Eventos row with only Tema = B"
        );
    }

    /// The rules lowercase `txt(...)` (already lowercase) and joins of lowercased parts. That
    /// equals the TypeScript order (join, then lowercase twice) only if lowercasing is idempotent
    /// and the space separator isolates each part; both are checked here over all of Unicode.
    #[test]
    fn lowercasing_is_idempotent_and_separable_by_spaces() {
        for c in (0..=0x10_ffff_u32).filter_map(char::from_u32) {
            let once = c.to_string().to_lowercase();
            assert_eq!(once.to_lowercase(), once, "U+{:04X}", u32::from(c));
        }
        let parts = [
            "ΟΔΟΣ",
            "Σ",
            "ΑΣ'",
            "'Σ",
            "A\u{301}Σ",
            "İSTANBUL",
            "ẞ",
            "",
            "x",
        ];
        for a in parts {
            for b in parts {
                let joined = format!("{a} {b}").to_lowercase();
                assert_eq!(
                    joined,
                    format!("{} {}", a.to_lowercase(), b.to_lowercase()),
                    "{a:?} {b:?}"
                );
            }
        }
    }
}
