//! PostgreSQL notices as the TypeScript tools print them: postgres.js has no `onnotice` there, so
//! each notice goes to `console.log` as a plain object (`util.inspect`, break length 80).

use std::fmt::Write as _;

use postgres::error::{DbError, ErrorPosition};

/// `util.inspect`'s `strEscape` for one string: quote choice and escapes.
fn quote(value: &str) -> String {
    let quote = if !value.contains('\'') {
        '\''
    } else if !value.contains('"') {
        '"'
    } else if !value.contains('`') && !value.contains("${") {
        '`'
    } else {
        '\''
    };
    let mut out = String::with_capacity(value.len() + 2);
    out.push(quote);
    for c in value.chars() {
        match c {
            '\u{8}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{B}' => out.push_str("\\x0B"),
            '\u{C}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            '\\' => out.push_str("\\\\"),
            '\'' if quote == '\'' => out.push_str("\\'"),
            '\u{0}'..='\u{1F}' | '\u{7F}'..='\u{9F}' => {
                let _ = write!(out, "\\x{:02X}", u32::from(c));
            }
            _ => out.push(c),
        }
    }
    out.push(quote);
    out
}

/// A property value: long strings with line breaks split into `'…\n' +` lines.
fn value(text: &str) -> String {
    // value.length > 16 && value.length > breakLength (80) - indentationLvl (2) - 4
    let units = crate::js::utf16_len(text);
    if units > 74 {
        let mut lines = Vec::new();
        let mut rest = text;
        while let Some(at) = rest.find('\n') {
            let (line, tail) = rest.split_at(at + 1);
            lines.push(line);
            rest = tail;
        }
        if !rest.is_empty() || lines.is_empty() {
            lines.push(rest);
        }
        return lines
            .iter()
            .map(|line| quote(line))
            .collect::<Vec<_>>()
            .join(" +\n    ");
    }
    quote(text)
}

/// The fields postgres.js reads, in the order PostgreSQL sends them.
fn fields(notice: &DbError) -> Vec<(&'static str, String)> {
    let mut out = vec![
        ("severity_local", notice.severity().to_owned()),
        (
            "severity",
            notice
                .parsed_severity()
                .map_or_else(|| notice.severity().to_owned(), |s| s.to_string()),
        ),
        ("code", notice.code().code().to_owned()),
        ("message", notice.message().to_owned()),
    ];
    let optional =
        |name: &'static str, value: Option<&str>, out: &mut Vec<(&'static str, String)>| {
            if let Some(value) = value {
                out.push((name, value.to_owned()));
            }
        };
    optional("detail", notice.detail(), &mut out);
    optional("hint", notice.hint(), &mut out);
    match notice.position() {
        Some(ErrorPosition::Original(position)) => out.push(("position", position.to_string())),
        Some(ErrorPosition::Internal { position, query }) => {
            out.push(("internal_position", position.to_string()));
            out.push(("internal_query", query.clone()));
        }
        None => {}
    }
    optional("where", notice.where_(), &mut out);
    optional("schema_name", notice.schema(), &mut out);
    optional("table_name", notice.table(), &mut out);
    optional("column_name", notice.column(), &mut out);
    optional("data_type_name", notice.datatype(), &mut out);
    optional("constraint_name", notice.constraint(), &mut out);
    optional("file", notice.file(), &mut out);
    if let Some(line) = notice.line() {
        out.push(("line", line.to_string()));
    }
    optional("routine", notice.routine(), &mut out);
    out
}

/// `util.inspect(notice)` of the object postgres.js builds.
#[must_use]
pub fn format(notice: &DbError) -> String {
    format_fields(&fields(notice))
}

/// `util.inspect` of a flat object of strings (keys are identifiers).
#[must_use]
pub fn format_fields(fields: &[(&str, String)]) -> String {
    let entries: Vec<String> = fields
        .iter()
        .map(|(k, v)| format!("{k}: {}", value(v)))
        .collect();
    // reduceToSingleString with compact 3: one line when it fits in 80 columns.
    let start = entries.len() + 1 + 10;
    let mut total = entries.len() + start;
    let mut fits = total + entries.len() <= 80;
    for entry in &entries {
        total += crate::js::utf16_len(entry);
        fits = fits && total <= 80;
    }
    let joined = entries.join(", ");
    if fits && !joined.contains('\n') {
        return format!("{{ {joined} }}");
    }
    format!("{{\n  {}\n}}", entries.join(",\n  "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(pairs: &[(&'static str, &str)]) -> String {
        format_fields(
            &pairs
                .iter()
                .map(|(k, v)| (*k, (*v).to_owned()))
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn inspects_like_node() {
        // Outputs observed with Node 22's console.log.
        assert_eq!(
            obj(&[("b", "xxxxxxxxxx\nyyyyy")]),
            "{ b: 'xxxxxxxxxx\\nyyyyy' }"
        );
        let split = format!("{}\n{}", "x".repeat(40), "y".repeat(34));
        assert_eq!(
            obj(&[("a", &split)]),
            format!(
                "{{\n  a: '{}\\n' +\n    '{}'\n}}",
                "x".repeat(40),
                "y".repeat(34)
            )
        );
        let kept = format!("{}\n{}", "x".repeat(40), "y".repeat(33));
        assert_eq!(
            obj(&[("a", &kept)]),
            format!("{{\n  a: '{}\\n{}'\n}}", "x".repeat(40), "y".repeat(33))
        );
        assert_eq!(
            obj(&[
                ("c", "it's"),
                ("d", "say \"hi\""),
                ("e", "both ' \""),
                ("f", "tab\there\u{1}\\")
            ]),
            "{ c: \"it's\", d: 'say \"hi\"', e: `both ' \"`, f: 'tab\\there\\x01\\\\' }"
        );
    }
}
